import type { DbClient } from '@server/db/client.ts';
import { adDirectorySyncs, adGroupMemberships, adGroups, adUsers } from '@server/db/schema.ts';
import type { LdapPool } from '@server/enricher/ldap-client.ts';
import type { AppLogger } from '@server/logger.ts';
import { desc, eq, sql } from 'drizzle-orm';
import { fetchAllGroups, fetchAllUsers, fetchGroupMembersTransitive } from './fetch-ad.ts';
import {
  type FetchedAdGroup,
  type FetchedAdUser,
  SyncAlreadyRunningError,
  type SyncSummary,
  type TriggerSource,
} from './types.ts';

const INSERT_CHUNK = 1000;

export interface AdSyncDeps {
  db: DbClient;
  ldap: LdapPool;
  logger: AppLogger;
  pageSize: number;
}

/**
 * Orquestra UMA execução completa de sync do diretório AD.
 *
 * Tudo o que é fetch acontece *antes* da transação, em memória. A transação
 * final só faz o swap atômico (TRUNCATE + INSERT bulk + UPSERT) — leitores
 * continuam vendo dados antigos até o COMMIT, sem inconsistência intermediária.
 *
 * Concorrência: o INSERT inicial em `ad_directory_syncs` com status='running'
 * conflita com a unique partial index `ad_directory_syncs_only_one_running`
 * se já houver execução em curso; nesse caso lançamos `SyncAlreadyRunningError`.
 */
export class AdDirectorySyncRunner {
  private runningPromise: Promise<SyncSummary> | null = null;

  constructor(private readonly deps: AdSyncDeps) {}

  /** Retorna o promise corrente se houver, ou inicia um novo ciclo. */
  async runOnce(triggeredBy: TriggerSource): Promise<SyncSummary> {
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = this.execute(triggeredBy).finally(() => {
      this.runningPromise = null;
    });
    return this.runningPromise;
  }

  /** True se há um ciclo em execução localmente neste processo. */
  isRunning(): boolean {
    return this.runningPromise !== null;
  }

  private async execute(triggeredBy: TriggerSource): Promise<SyncSummary> {
    const startedAt = new Date();
    const start = Date.now();
    const { db, ldap, logger, pageSize } = this.deps;

    let syncId: string;
    try {
      const inserted = await db.db
        .insert(adDirectorySyncs)
        .values({ status: 'running', triggeredBy })
        .returning({ id: adDirectorySyncs.id });
      const row = inserted[0];
      if (!row) throw new Error('insert ad_directory_syncs retornou vazio');
      syncId = row.id;
    } catch (err) {
      // Unique partial index `ad_directory_syncs_only_one_running` violada.
      if (isUniqueViolation(err)) throw new SyncAlreadyRunningError();
      throw err;
    }

    logger.info({ syncId, triggeredBy }, 'ad-sync: iniciado');

    try {
      // 1) Buscar grupos e usuários em paralelo.
      const [groups, users] = await Promise.all([
        fetchAllGroups(ldap, pageSize, logger),
        fetchAllUsers(ldap, pageSize, logger),
      ]);

      // 2) Mapa DN→SID de usuários para resolver memberOf transitivo.
      const userSidByDn = new Map<string, string>();
      for (const u of users) {
        userSidByDn.set(u.distinguishedName.toLowerCase(), u.sid);
      }

      // 3) Para cada grupo, buscar membros transitivos (N+1 LDAP calls).
      //    Não paralelizamos para não saturar o controlador de domínio nem
      //    o pool LDAP (single-instance).
      type MembershipPair = { userSid: string; groupSid: string; isDirect: boolean };
      const memberships: MembershipPair[] = [];
      const memberCountByGroupSid = new Map<string, number>();

      // Pre-calcula set de DNs diretos por user para classificar isDirect.
      const directGroupDnsByUserSid = new Map<string, Set<string>>();
      for (const u of users) {
        const lowered = new Set<string>();
        for (const dn of u.directGroupDns) lowered.add(dn.toLowerCase());
        directGroupDnsByUserSid.set(u.sid, lowered);
      }

      let processedGroups = 0;
      for (const g of groups) {
        const memberSids = await fetchGroupMembersTransitive(
          ldap,
          g.distinguishedName,
          pageSize,
        ).catch((err) => {
          logger.warn(
            { err, groupSid: g.sid, groupDn: g.distinguishedName },
            'ad-sync: falha ao expandir grupo — ignorado',
          );
          return [] as string[];
        });
        memberCountByGroupSid.set(g.sid, memberSids.length);
        const dnLower = g.distinguishedName.toLowerCase();
        for (const userSid of memberSids) {
          const directSet = directGroupDnsByUserSid.get(userSid);
          const isDirect = directSet ? directSet.has(dnLower) : false;
          memberships.push({ userSid, groupSid: g.sid, isDirect });
        }
        processedGroups++;
        if (processedGroups % 50 === 0) {
          logger.debug(
            { processedGroups, totalGroups: groups.length },
            'ad-sync: progresso expansão',
          );
        }
      }

      logger.info(
        {
          groups: groups.length,
          users: users.length,
          memberships: memberships.length,
        },
        'ad-sync: fetch concluído, iniciando persistência',
      );

      // 4) Persistir tudo em transação única (swap atômico).
      await db.db.transaction(async (tx) => {
        // ad_groups e ad_group_memberships são tabelas de "espelho":
        // TRUNCATE + INSERT bulk é mais simples que diff, e mantém leitura
        // consistente até o COMMIT.
        await tx.execute(sql`TRUNCATE TABLE ad_group_memberships`);
        await tx.execute(sql`TRUNCATE TABLE ad_groups`);

        // Bulk insert ad_groups em chunks
        if (groups.length > 0) {
          const groupRows = groups.map((g) => ({
            sid: g.sid,
            distinguishedName: g.distinguishedName,
            samAccountName: g.samAccountName,
            cn: g.cn,
            displayName: g.displayName,
            description: g.description,
            groupType: g.groupType,
            isSecurity: g.isSecurity,
            scope: g.scope,
            memberCount: memberCountByGroupSid.get(g.sid) ?? 0,
            lastSyncedAt: startedAt,
          }));
          for (const chunk of chunked(groupRows, INSERT_CHUNK)) {
            await tx.insert(adGroups).values(chunk);
          }
        }

        // Bulk insert ad_group_memberships em chunks, deduplicando pelo PK.
        if (memberships.length > 0) {
          const seen = new Set<string>();
          const dedup: typeof memberships = [];
          for (const m of memberships) {
            const key = `${m.userSid}|${m.groupSid}`;
            if (seen.has(key)) continue;
            seen.add(key);
            dedup.push(m);
          }
          for (const chunk of chunked(dedup, INSERT_CHUNK)) {
            await tx.insert(adGroupMemberships).values(chunk);
          }
        }

        // UPSERT em ad_users — não TRUNCATE para preservar SIDs que o enricher
        // cacheou mas que sumiram do AD (deleted users que ainda estão em
        // effective_members históricos).
        if (users.length > 0) {
          const userRows = users.map((u) => ({
            sid: u.sid,
            samAccountName: u.samAccountName,
            userPrincipalName: u.userPrincipalName,
            displayName: u.displayName,
            email: u.email,
            department: u.department,
            title: u.title,
            managerDn: u.managerDn,
            distinguishedName: u.distinguishedName,
            enabled: u.enabled,
            passwordLastSet: u.passwordLastSet,
            lastLogon: u.lastLogon,
            accountExpires: u.accountExpires,
            isServiceAccount: u.isServiceAccount,
            lastSyncedAt: startedAt,
          }));
          for (const chunk of chunked(userRows, INSERT_CHUNK)) {
            await tx
              .insert(adUsers)
              .values(chunk)
              .onConflictDoUpdate({
                target: adUsers.sid,
                set: {
                  samAccountName: sql`excluded.sam_account_name`,
                  userPrincipalName: sql`excluded.user_principal_name`,
                  displayName: sql`excluded.display_name`,
                  email: sql`excluded.email`,
                  department: sql`excluded.department`,
                  title: sql`excluded.title`,
                  managerDn: sql`excluded.manager_dn`,
                  distinguishedName: sql`excluded.distinguished_name`,
                  enabled: sql`excluded.enabled`,
                  passwordLastSet: sql`excluded.password_last_set`,
                  lastLogon: sql`excluded.last_logon`,
                  accountExpires: sql`excluded.account_expires`,
                  isServiceAccount: sql`excluded.is_service_account`,
                  lastSyncedAt: sql`excluded.last_synced_at`,
                },
              });
          }
        }
      });

      const durationMs = Date.now() - start;
      await db.db
        .update(adDirectorySyncs)
        .set({
          status: 'success',
          finishedAt: new Date(),
          usersTotal: users.length,
          groupsTotal: groups.length,
          membershipsTotal: memberships.length,
          durationMs,
        })
        .where(eq(adDirectorySyncs.id, syncId));

      logger.info(
        {
          syncId,
          users: users.length,
          groups: groups.length,
          memberships: memberships.length,
          durationMs,
        },
        'ad-sync: concluído com sucesso',
      );

      return {
        syncId,
        usersTotal: users.length,
        groupsTotal: groups.length,
        membershipsTotal: memberships.length,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMessage = err instanceof Error ? err.message : String(err);
      await db.db
        .update(adDirectorySyncs)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          durationMs,
          errorMessage,
        })
        .where(eq(adDirectorySyncs.id, syncId))
        .catch((updateErr) => {
          logger.error({ err: updateErr, syncId }, 'ad-sync: falha ao registrar falha');
        });
      logger.error({ err, syncId, durationMs }, 'ad-sync: execução falhou');
      throw err;
    }
  }
}

/**
 * Verifica se há um sync registrado em `running` (em qualquer processo).
 * Usado pelos endpoints de status — distinto do `isRunning()` local.
 */
export async function getCurrentRunningSync(
  db: DbClient,
): Promise<typeof adDirectorySyncs.$inferSelect | null> {
  const rows = await db.db
    .select()
    .from(adDirectorySyncs)
    .where(eq(adDirectorySyncs.status, 'running'))
    .orderBy(desc(adDirectorySyncs.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLastFinishedSync(
  db: DbClient,
): Promise<typeof adDirectorySyncs.$inferSelect | null> {
  const rows = await db.db
    .select()
    .from(adDirectorySyncs)
    .where(sql`status IN ('success', 'failed')`)
    .orderBy(desc(adDirectorySyncs.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  // PostgreSQL SQLSTATE 23505 = unique_violation
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

// Mantém imports usados que o lint poderia podar (sql usado em raw e excluded)
export type { FetchedAdGroup, FetchedAdUser };
