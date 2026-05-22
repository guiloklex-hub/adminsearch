import type { DbClient } from '@server/db/client.ts';
import {
  effectiveMembers,
  findingsEvents,
  machines,
  rawMembers,
  scanRuns,
} from '@server/db/schema.ts';
import { AdUserCache } from '@server/enricher/ad-user-cache.ts';
import { findMatchingException } from '@server/enricher/exception-matcher.ts';
import { type ExpandedGroupResult, expandGroupBySid } from '@server/enricher/expand-group.ts';
import type { LdapPool } from '@server/enricher/ldap-client.ts';
import { type MemberSource, type Severity, classifySeverity } from '@server/enricher/severity.ts';
import {
  isDomainOrLocalAccountSid,
  isExpandableWellKnownGroupSid,
  isWellKnownSid,
  wellKnownName,
} from '@server/enricher/well-known.ts';
import type { AppLogger } from '@server/logger.ts';
import { and, asc, desc, eq, lt, ne, sql } from 'drizzle-orm';

export interface EnricherDeps {
  db: DbClient;
  ldap: LdapPool;
  logger: AppLogger;
  pollMs: number;
  cacheTtlMs: number;
}

interface EffectiveDraft {
  sid: string;
  name: string | null;
  source: MemberSource;
  viaGroup: string | null;
  viaGroupSid: string | null;
  adEnabled: boolean | null;
  isServiceAccount: boolean;
  severity: Severity;
  matchedExceptionId: string | null;
}

export class Enricher {
  private stopped = false;
  private readonly cache: AdUserCache;

  constructor(private readonly deps: EnricherDeps) {
    this.cache = new AdUserCache(deps.db, deps.ldap, deps.cacheTtlMs);
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const processed = await this.processOne();
        if (!processed) {
          await sleep(this.deps.pollMs);
        }
      } catch (err) {
        this.deps.logger.error({ err }, 'enricher loop error');
        await sleep(this.deps.pollMs);
      }
    }
  }

  /**
   * Claim atômico de um scan pendente com `FOR UPDATE SKIP LOCKED`.
   * Retorna `true` se processou algo (mesmo que tenha falhado e marcado como
   * `failed`).
   */
  async processOne(): Promise<boolean> {
    const claim = await this.deps.db.db.execute(sql`
      WITH pick AS (
        SELECT id FROM scan_runs
        WHERE expansion_status = 'pending'
        ORDER BY received_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE scan_runs sr
      SET expansion_status = 'processing',
          expansion_started_at = now()
      FROM pick
      WHERE sr.id = pick.id
      RETURNING sr.id, sr.machine_id;
    `);

    const row = (claim.rows[0] as { id: string; machine_id: string } | undefined) ?? null;
    if (!row) return false;

    const scanId = row.id;
    const machineId = row.machine_id;

    try {
      await this.expand(scanId, machineId);
      await this.deps.db.db
        .update(scanRuns)
        .set({
          expansionStatus: 'done',
          expansionFinishedAt: new Date(),
          expansionError: null,
        })
        .where(eq(scanRuns.id, scanId));
      this.deps.logger.info({ scanId, machineId }, 'scan expandido');
      return true;
    } catch (err) {
      this.deps.logger.error({ err, scanId, machineId }, 'falha ao expandir scan');
      await this.deps.db.db
        .update(scanRuns)
        .set({
          expansionStatus: 'failed',
          expansionFinishedAt: new Date(),
          expansionError: (err as Error).message,
        })
        .where(eq(scanRuns.id, scanId));
      return true;
    }
  }

  private async expand(scanId: string, machineId: string): Promise<void> {
    // 0. Hostname/NetBIOS da máquina — usado para distinguir LOCAL_USER de AD_USER
    //    pelo prefixo "DOMAIN\X" do nome reportado pelo agente.
    const machineRow = await this.deps.db.db.query.machines.findFirst({
      where: eq(machines.id, machineId),
      columns: { netBiosName: true, dnsHostName: true },
    });
    const netBios = (machineRow?.netBiosName ?? '').toLowerCase();

    // 1. Raw members
    const raw = await this.deps.db.db
      .select()
      .from(rawMembers)
      .where(eq(rawMembers.scanRunId, scanId));

    // 2. Particionar em grupos vs candidatos a user.
    //    - objectClass='Group' do agente → grupo.
    //    - RID built-in de grupo do dominio (Domain Admins, Enterprise Admins,
    //      Schema Admins, etc) → grupo, MESMO que o agente PS tenha mandado
    //      como User (Get-LocalGroupMember misclassifica em varios cenarios).
    //    - resto → user candidate; ainda passa por backstop para detectar
    //      grupo de dominio nao-built-in que o agente classificou errado.
    const drafts: EffectiveDraft[] = [];

    const groupSids = new Set<string>();
    const userCandidates: typeof raw = [];

    for (const r of raw) {
      if (r.objectClass === 'Group' || isExpandableWellKnownGroupSid(r.sid)) {
        groupSids.add(r.sid);
      } else {
        userCandidates.push(r);
      }
    }

    // 3. Enriquecer users via cache LDAP (com fallback por sAMAccountName)
    const userHints = userCandidates
      .filter((u) => isDomainOrLocalAccountSid(u.sid))
      .map((u) => ({ sid: u.sid, samAccountName: extractSam(u.name) }));
    const directAdUsers = await this.cache.getManyWithHints(userHints);

    // 4. Backstop: users de dominio que NAO casaram no cache LDAP podem ser
    //    grupos mal-classificados pelo agente. Tentar expandir como grupo
    //    antes de descer pra ORPHAN_SID. Caches o resultado para nao buscar
    //    de novo na fase 6.
    const preExpanded = new Map<string, ExpandedGroupResult>();
    const stillUsers: typeof raw = [];
    for (const r of userCandidates) {
      const cached = directAdUsers.get(r.sid);
      if (!cached && isDomainOrLocalAccountSid(r.sid) && !isWellKnownSid(r.sid)) {
        const maybeGroup = await expandGroupBySid(
          this.deps.ldap,
          r.sid,
          r.name ?? null,
          this.deps.logger,
        ).catch(() => null);
        if (maybeGroup) {
          this.deps.logger.info(
            { sid: r.sid, agentClass: r.objectClass, groupCn: maybeGroup.groupCn },
            'backstop: SID classificado pelo agente como nao-grupo casou como grupo no LDAP',
          );
          groupSids.add(r.sid);
          preExpanded.set(r.sid, maybeGroup);
          continue;
        }
      }
      stillUsers.push(r);
    }

    // 5. Criar drafts de users diretos
    for (const r of stillUsers) {
      const cached = directAdUsers.get(r.sid) ?? null;
      const source = this.classifySource(r.sid, r.resolved, !!cached, r.name, netBios);
      const name =
        cached?.displayName ??
        cached?.samAccountName ??
        cleanRawName(r.name) ??
        wellKnownName(r.sid);
      const draft: EffectiveDraft = {
        sid: r.sid,
        name,
        source,
        viaGroup: null,
        viaGroupSid: null,
        adEnabled: cached?.enabled ?? null,
        isServiceAccount: cached?.isServiceAccount ?? false,
        severity: 'medium',
        matchedExceptionId: null,
      };

      const exc = await findMatchingException(this.deps.db, {
        machineId,
        sid: draft.sid,
        samAccountName: cached?.samAccountName ?? null,
        groupSid: null,
        groupCn: null,
      });
      draft.matchedExceptionId = exc?.id ?? null;
      draft.severity = classifySeverity({
        sid: draft.sid,
        source,
        hasMatchedException: !!exc,
        adUser: cached,
        viaGroup: null,
        viaGroupSid: null,
      });

      drafts.push(draft);
    }

    // 6. Expansão de grupos AD
    for (const groupSid of groupSids) {
      const rawGroup = raw.find((r) => r.sid === groupSid);
      const rawName = cleanRawName(rawGroup?.name ?? null);

      // Built-in NAO expansivel (BUILTIN\*, NT AUTHORITY\*): so registra
      // a entrada do grupo, sem expandir via LDAP.
      if (isWellKnownSid(groupSid) && !isExpandableWellKnownGroupSid(groupSid)) {
        drafts.push({
          sid: groupSid,
          name: rawName ?? wellKnownName(groupSid),
          source: 'WELL_KNOWN',
          viaGroup: null,
          viaGroupSid: null,
          adEnabled: null,
          isServiceAccount: false,
          severity: 'low',
          matchedExceptionId: null,
        });
        continue;
      }

      // Grupos do dominio (incluindo built-in expansiveis): expandir via LDAP.
      const expanded =
        preExpanded.get(groupSid) ??
        (await expandGroupBySid(
          this.deps.ldap,
          groupSid,
          rawGroup?.name ?? null,
          this.deps.logger,
        ).catch((err) => {
          this.deps.logger.warn({ err, groupSid }, 'falha ao expandir grupo');
          return null;
        }));

      // Entrada do GRUPO em si — mesmo expandindo, queremos registrar que o
      // grupo aparece em Administrators local. Se for built-in do dominio
      // (Domain Admins, Enterprise Admins...), e' WELL_KNOWN critical.
      const isBuiltinDomain = isExpandableWellKnownGroupSid(groupSid);
      if (isBuiltinDomain) {
        drafts.push({
          sid: groupSid,
          name: expanded?.groupCn ?? rawName ?? wellKnownName(groupSid),
          source: 'WELL_KNOWN',
          viaGroup: null,
          viaGroupSid: null,
          adEnabled: null,
          isServiceAccount: false,
          severity: classifySeverity({
            sid: groupSid,
            source: 'WELL_KNOWN',
            hasMatchedException: false,
            adUser: null,
            viaGroup: null,
            viaGroupSid: null,
          }),
          matchedExceptionId: null,
        });
      }

      if (!expanded) {
        // Grupo nao built-in que falhou a expansao via LDAP. So registra
        // se nao for built-in (esse caso ja registrou WELL_KNOWN acima).
        if (!isBuiltinDomain) {
          drafts.push({
            sid: groupSid,
            name: rawName,
            source: 'ORPHAN_SID',
            viaGroup: null,
            viaGroupSid: null,
            adEnabled: null,
            isServiceAccount: false,
            severity: 'critical',
            matchedExceptionId: null,
          });
        }
        continue;
      }

      const cachedMap = await this.cache.getManyWithHints(
        expanded.users.map((u) => ({ sid: u.sid, samAccountName: u.samAccountName })),
      );

      for (const u of expanded.users) {
        const cached = cachedMap.get(u.sid) ?? null;
        const source: MemberSource = cached ? 'AD_USER' : 'ORPHAN_SID';
        const exc = await findMatchingException(this.deps.db, {
          machineId,
          sid: u.sid,
          samAccountName: cached?.samAccountName ?? u.samAccountName,
          groupSid: expanded.groupSid,
          groupCn: expanded.groupCn,
        });
        drafts.push({
          sid: u.sid,
          name: cached?.displayName ?? cached?.samAccountName ?? u.samAccountName,
          source,
          viaGroup: expanded.groupCn,
          viaGroupSid: expanded.groupSid,
          adEnabled: cached?.enabled ?? null,
          isServiceAccount: cached?.isServiceAccount ?? false,
          severity: classifySeverity({
            sid: u.sid,
            source,
            hasMatchedException: !!exc,
            adUser: cached,
            viaGroup: expanded.groupCn,
            viaGroupSid: expanded.groupSid,
          }),
          matchedExceptionId: exc?.id ?? null,
        });
      }
    }

    // 3. Persistir effective_members
    if (drafts.length > 0) {
      await this.deps.db.db.insert(effectiveMembers).values(
        drafts.map((d) => ({
          scanRunId: scanId,
          machineId,
          sid: d.sid,
          name: d.name,
          source: d.source,
          viaGroup: d.viaGroup,
          viaGroupSid: d.viaGroupSid,
          adEnabled: d.adEnabled,
          isServiceAccount: d.isServiceAccount,
          severity: d.severity,
          matchedExceptionId: d.matchedExceptionId,
        })),
      );
    }

    // 4. Gerar diff vs scan anterior
    await this.generateDiff(machineId, scanId, drafts);
  }

  private classifySource(
    sid: string,
    resolved: boolean,
    hasAd: boolean,
    rawName: string | null,
    netBiosLower: string,
  ): MemberSource {
    if (isWellKnownSid(sid)) return 'WELL_KNOWN';
    if (hasAd) return 'AD_USER';
    if (!resolved) return 'ORPHAN_SID';

    // Heuristica por prefixo DOMAIN\X: se o DOMAIN do nome reportado é
    // diferente do NetBIOS da máquina (e não é built-in/NT AUTHORITY), o
    // member vem do AD — só que o enricher não conseguiu enriquecer pelo
    // LDAP. Mesmo assim, é AD_USER (não LOCAL).
    const name = rawName ?? '';
    if (name.includes('\\')) {
      const domainPart = (name.split('\\')[0] ?? '').toLowerCase();
      const isBuiltin =
        domainPart === 'builtin' ||
        domainPart === 'nt authority' ||
        domainPart === 'nt service' ||
        domainPart === '';
      if (!isBuiltin && netBiosLower && domainPart !== netBiosLower) {
        return 'AD_USER';
      }
    }

    if (isDomainOrLocalAccountSid(sid)) {
      return 'LOCAL_USER';
    }
    return 'LOCAL_USER';
  }

  /**
   * Compara o scan recém-expandido com o último scan `done` anterior da mesma
   * máquina e registra eventos ADMIN_ADDED / ADMIN_REMOVED / ORPHAN_DETECTED.
   */
  private async generateDiff(
    machineId: string,
    scanId: string,
    drafts: EffectiveDraft[],
  ): Promise<void> {
    const previous = await this.deps.db.db.query.scanRuns.findFirst({
      where: and(
        eq(scanRuns.machineId, machineId),
        eq(scanRuns.expansionStatus, 'done'),
        ne(scanRuns.id, scanId),
        lt(scanRuns.collectedAt, new Date()),
      ),
      orderBy: [desc(scanRuns.collectedAt)],
    });

    const currentSids = new Set(drafts.map((d) => d.sid));
    const events: {
      kind: string;
      sid: string | null;
      name: string | null;
      details: Record<string, unknown>;
    }[] = [];

    if (!previous) {
      for (const d of drafts) {
        if (d.source === 'ORPHAN_SID') {
          events.push({
            kind: 'ORPHAN_DETECTED',
            sid: d.sid,
            name: d.name,
            details: { firstScan: true },
          });
        }
      }
    } else {
      const prevEffective = await this.deps.db.db
        .select({
          sid: effectiveMembers.sid,
          name: effectiveMembers.name,
          source: effectiveMembers.source,
          viaGroup: effectiveMembers.viaGroup,
        })
        .from(effectiveMembers)
        .where(eq(effectiveMembers.scanRunId, previous.id))
        .orderBy(asc(effectiveMembers.sid));

      const prevSids = new Set(prevEffective.map((p) => p.sid));

      // Adicionados
      for (const d of drafts) {
        if (!prevSids.has(d.sid)) {
          events.push({
            kind: 'ADMIN_ADDED',
            sid: d.sid,
            name: d.name,
            details: { source: d.source, viaGroup: d.viaGroup, severity: d.severity },
          });
        }
        if (d.source === 'ORPHAN_SID') {
          const wasOrphanBefore = prevEffective.find(
            (p) => p.sid === d.sid && p.source === 'ORPHAN_SID',
          );
          if (!wasOrphanBefore) {
            events.push({
              kind: 'ORPHAN_DETECTED',
              sid: d.sid,
              name: d.name,
              details: { viaGroup: d.viaGroup },
            });
          }
        }
      }

      // Removidos
      for (const p of prevEffective) {
        if (!currentSids.has(p.sid)) {
          events.push({
            kind: 'ADMIN_REMOVED',
            sid: p.sid,
            name: p.name,
            details: { source: p.source, viaGroup: p.viaGroup },
          });
        }
      }
    }

    if (events.length > 0) {
      await this.deps.db.db.insert(findingsEvents).values(
        events.map((e) => ({
          machineId,
          scanRunId: scanId,
          kind: e.kind,
          sid: e.sid,
          name: e.name,
          details: e.details,
        })),
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extrai o sAMAccountName de um nome no formato "DOMAIN\sam" ou "sam".
 * Retorna null se vazio.
 */
function extractSam(name: string | null): string | null {
  const cleaned = cleanRawName(name);
  if (!cleaned) return null;
  const last = cleaned.includes('\\') ? (cleaned.split('\\').pop() ?? '') : cleaned;
  const trimmed = last.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Sanitiza nomes vindos do agente PS: descarta valores degenerados que
 * historicamente o `Get-LocalGroupMember` / `InvokeMember('Name', ...)`
 * emitiu — "{}" (objeto COM sem propriedades enumeraveis), "[]", string
 * vazia, ou o proprio SID quando a resolucao local falhou. Esses casos
 * devem cair como `null` para o resto do pipeline tentar resolver via
 * LDAP / `wellKnownName`.
 */
function cleanRawName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = String(name).trim();
  if (trimmed === '') return null;
  if (trimmed === '{}' || trimmed === '[]') return null;
  if (/^S-\d+-\d+(-\d+)*$/.test(trimmed)) return null; // veio so o SID
  return trimmed;
}
