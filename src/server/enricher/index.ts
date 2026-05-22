import { and, asc, desc, eq, lt, ne, sql } from 'drizzle-orm';
import type { DbClient } from '@server/db/client.ts';
import { effectiveMembers, findingsEvents, rawMembers, scanRuns } from '@server/db/schema.ts';
import { AdUserCache } from '@server/enricher/ad-user-cache.ts';
import { expandGroupBySid } from '@server/enricher/expand-group.ts';
import { findMatchingException } from '@server/enricher/exception-matcher.ts';
import { LdapPool } from '@server/enricher/ldap-client.ts';
import {
  type MemberSource,
  type Severity,
  classifySeverity,
} from '@server/enricher/severity.ts';
import { isDomainOrLocalAccountSid, isWellKnownSid } from '@server/enricher/well-known.ts';
import type { AppLogger } from '@server/logger.ts';

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
    // 1. Raw members
    const raw = await this.deps.db.db
      .select()
      .from(rawMembers)
      .where(eq(rawMembers.scanRunId, scanId));

    // 2. Para cada grupo AD, expandir
    const drafts: EffectiveDraft[] = [];

    const directUserSids: string[] = [];
    const groupSids: string[] = [];

    for (const r of raw) {
      if (r.objectClass === 'Group') groupSids.push(r.sid);
      else if (r.objectClass === 'User') directUserSids.push(r.sid);
      else directUserSids.push(r.sid); // Unknown — tentamos resolver como user
    }

    // Direct users — enriquece com cache
    const directAdUsers = await this.cache.getMany(
      directUserSids.filter(isDomainOrLocalAccountSid),
    );

    for (const r of raw) {
      if (r.objectClass === 'Group') continue;

      const cached = directAdUsers.get(r.sid) ?? null;
      const source = this.classifySource(r.sid, r.resolved, !!cached);
      const draft: EffectiveDraft = {
        sid: r.sid,
        name: cached?.displayName ?? cached?.samAccountName ?? r.name ?? null,
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
      });

      drafts.push(draft);
    }

    // Expansão de grupos AD
    for (const groupSid of groupSids) {
      const rawGroup = raw.find((r) => r.sid === groupSid);
      if (isWellKnownSid(groupSid)) {
        // Grupos built-in BUILTIN\* não precisam expandir via LDAP — eles
        // representam coletânea local; logamos o grupo direto.
        drafts.push({
          sid: groupSid,
          name: rawGroup?.name ?? null,
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

      // Grupos do domínio: expandir, com fallback por sAMAccountName
      const expanded = await expandGroupBySid(
        this.deps.ldap,
        groupSid,
        rawGroup?.name ?? null,
      ).catch((err) => {
        this.deps.logger.warn({ err, groupSid }, 'falha ao expandir grupo');
        return null;
      });

      if (!expanded) {
        drafts.push({
          sid: groupSid,
          name: rawGroup?.name ?? null,
          source: 'ORPHAN_SID',
          viaGroup: null,
          viaGroupSid: null,
          adEnabled: null,
          isServiceAccount: false,
          severity: 'critical',
          matchedExceptionId: null,
        });
        continue;
      }

      const userSids = expanded.users.map((u) => u.sid);
      const cachedMap = await this.cache.getMany(userSids);

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

  private classifySource(sid: string, resolved: boolean, hasAd: boolean): MemberSource {
    if (isWellKnownSid(sid)) return 'WELL_KNOWN';
    if (hasAd) return 'AD_USER';
    if (!resolved) return 'ORPHAN_SID';
    if (isDomainOrLocalAccountSid(sid)) {
      // SID de domínio que não casou no AD — provavelmente conta local da própria
      // máquina (com authority 21 idêntica ao computer).
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
