import {
  type AdDirectorySyncRunner,
  getCurrentRunningSync,
  getLastFinishedSync,
} from '@server/ad-sync/runner.ts';
import { SyncAlreadyRunningError } from '@server/ad-sync/types.ts';
import type { DbClient } from '@server/db/client.ts';
import { adDirectorySyncs, auditLog } from '@server/db/schema.ts';
import { desc, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const SidParam = z.object({
  sid: z
    .string()
    .min(1)
    .max(184)
    .regex(/^S-\d+-\d+(-\d+)*$/i, 'SID inválido'),
});

const csvBool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => (typeof v === 'string' ? v === 'true' : (v ?? false)));

const csvList = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

const GroupsListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  scope: csvList,
  isSecurity: csvBool,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.enum(['name', 'memberCount', 'scope']).default('name'),
});

const GroupMembersQuery = z.object({
  q: z.string().trim().max(120).optional(),
  onlyEnabled: csvBool,
  onlyDirect: csvBool,
  hideServiceAccounts: csvBool,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

const UsersListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  onlyEnabled: csvBool,
  hideServiceAccounts: csvBool,
  department: z.string().trim().max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.enum(['name', 'groupCount', 'lastLogon']).default('name'),
});

const UserGroupsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  onlyDirect: csvBool,
});

const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function registerAdDirectoryRoutes(
  app: FastifyInstance,
  deps: { db: DbClient; runner: AdDirectorySyncRunner | null },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  // ---------- LISTAGEM DE GRUPOS ----------
  app.get('/api/v1/ad-directory/groups', async (req, reply) => {
    const q = GroupsListQuery.parse(req.query);
    const pageSize = q.pageSize;
    const offset = (q.page - 1) * pageSize;

    const conditions: string[] = [];
    if (q.q) {
      const safe = q.q.replace(/'/g, "''");
      conditions.push(
        `(COALESCE(g.display_name,'') ILIKE '%${safe}%' OR COALESCE(g.sam_account_name,'') ILIKE '%${safe}%' OR COALESCE(g.cn,'') ILIKE '%${safe}%' OR g.sid ILIKE '%${safe}%')`,
      );
    }
    if (q.scope && q.scope.length > 0) {
      const safeScopes = q.scope
        .filter((s) => /^[a-z_]+$/.test(s))
        .map((s) => `'${s}'`)
        .join(',');
      if (safeScopes) conditions.push(`g.scope IN (${safeScopes})`);
    }
    if (q.isSecurity) conditions.push('g.is_security = true');

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy =
      q.sort === 'memberCount'
        ? 'g.member_count DESC NULLS LAST, COALESCE(g.display_name, g.cn, g.sam_account_name) ASC'
        : q.sort === 'scope'
          ? 'g.scope ASC NULLS LAST, COALESCE(g.display_name, g.cn, g.sam_account_name) ASC'
          : 'COALESCE(g.display_name, g.cn, g.sam_account_name) ASC';

    const totalRow = await deps.db.db.execute(sql`
      SELECT COUNT(*)::int AS total FROM ad_groups g ${sql.raw(whereClause)};
    `);
    const total = (totalRow.rows[0] as { total: number } | undefined)?.total ?? 0;

    const rows = await deps.db.db.execute(sql`
      SELECT
        g.sid,
        COALESCE(g.display_name, g.cn, g.sam_account_name, g.sid) AS name,
        g.sam_account_name,
        g.cn,
        g.description,
        g.scope,
        g.is_security,
        g.member_count,
        g.last_synced_at
      FROM ad_groups g
      ${sql.raw(whereClause)}
      ORDER BY ${sql.raw(orderBy)}
      LIMIT ${pageSize}
      OFFSET ${offset};
    `);

    reply.send({ items: rows.rows, total, page: q.page, pageSize });
  });

  // ---------- MEMBROS DE UM GRUPO ----------
  app.get('/api/v1/ad-directory/groups/:sid/members', async (req, reply) => {
    const { sid } = SidParam.parse(req.params);
    const q = GroupMembersQuery.parse(req.query);
    const pageSize = q.pageSize;
    const offset = (q.page - 1) * pageSize;

    const conditions: string[] = [`m.group_sid = '${sid.replace(/'/g, "''")}'`];
    if (q.onlyEnabled) conditions.push('COALESCE(u.enabled, true) = true');
    if (q.onlyDirect) conditions.push('m.is_direct = true');
    if (q.hideServiceAccounts) conditions.push('COALESCE(u.is_service_account, false) = false');
    if (q.q) {
      const safe = q.q.replace(/'/g, "''");
      conditions.push(
        `(COALESCE(u.display_name,'') ILIKE '%${safe}%' OR COALESCE(u.sam_account_name,'') ILIKE '%${safe}%' OR COALESCE(u.email,'') ILIKE '%${safe}%' OR COALESCE(u.department,'') ILIKE '%${safe}%' OR m.user_sid ILIKE '%${safe}%')`,
      );
    }
    const cleanWhere = `WHERE ${conditions.join(' AND ')}`;

    const totalRow = await deps.db.db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM ad_group_memberships m
      LEFT JOIN ad_users u ON u.sid = m.user_sid
      ${sql.raw(cleanWhere)};
    `);
    const total = (totalRow.rows[0] as { total: number } | undefined)?.total ?? 0;

    const rows = await deps.db.db.execute(sql`
      SELECT
        m.user_sid AS sid,
        COALESCE(u.display_name, m.user_sid) AS name,
        u.sam_account_name,
        u.user_principal_name,
        u.email,
        u.department,
        u.title,
        u.enabled,
        COALESCE(u.is_service_account, false) AS is_service_account,
        u.last_logon,
        m.is_direct
      FROM ad_group_memberships m
      LEFT JOIN ad_users u ON u.sid = m.user_sid
      ${sql.raw(cleanWhere)}
      ORDER BY COALESCE(u.display_name, m.user_sid) ASC
      LIMIT ${pageSize}
      OFFSET ${offset};
    `);

    reply.send({ items: rows.rows, total, page: q.page, pageSize });
  });

  // ---------- LISTAGEM DE USUÁRIOS ----------
  app.get('/api/v1/ad-directory/users', async (req, reply) => {
    const q = UsersListQuery.parse(req.query);
    const pageSize = q.pageSize;
    const offset = (q.page - 1) * pageSize;

    const conditions: string[] = [];
    if (q.q) {
      const safe = q.q.replace(/'/g, "''");
      conditions.push(
        `(COALESCE(u.display_name,'') ILIKE '%${safe}%' OR COALESCE(u.sam_account_name,'') ILIKE '%${safe}%' OR COALESCE(u.user_principal_name,'') ILIKE '%${safe}%' OR COALESCE(u.email,'') ILIKE '%${safe}%' OR COALESCE(u.department,'') ILIKE '%${safe}%' OR u.sid ILIKE '%${safe}%')`,
      );
    }
    if (q.onlyEnabled) conditions.push('COALESCE(u.enabled, true) = true');
    if (q.hideServiceAccounts) conditions.push('COALESCE(u.is_service_account, false) = false');
    if (q.department) {
      const safe = q.department.replace(/'/g, "''");
      conditions.push(`COALESCE(u.department, '') = '${safe}'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy =
      q.sort === 'groupCount'
        ? 'group_count DESC, COALESCE(u.display_name, u.sam_account_name, u.sid) ASC'
        : q.sort === 'lastLogon'
          ? 'u.last_logon DESC NULLS LAST, COALESCE(u.display_name, u.sam_account_name, u.sid) ASC'
          : 'COALESCE(u.display_name, u.sam_account_name, u.sid) ASC';

    const totalRow = await deps.db.db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM ad_users u
      ${sql.raw(whereClause)};
    `);
    const total = (totalRow.rows[0] as { total: number } | undefined)?.total ?? 0;

    const rows = await deps.db.db.execute(sql`
      SELECT
        u.sid,
        u.sam_account_name,
        u.user_principal_name,
        u.display_name,
        u.email,
        u.department,
        u.title,
        u.enabled,
        u.is_service_account,
        u.last_logon,
        COALESCE(gc.cnt, 0)::int AS group_count
      FROM ad_users u
      LEFT JOIN (
        SELECT user_sid, COUNT(*)::int AS cnt
        FROM ad_group_memberships
        GROUP BY user_sid
      ) gc ON gc.user_sid = u.sid
      ${sql.raw(whereClause)}
      ORDER BY ${sql.raw(orderBy)}
      LIMIT ${pageSize}
      OFFSET ${offset};
    `);

    reply.send({ items: rows.rows, total, page: q.page, pageSize });
  });

  // ---------- GRUPOS DE UM USUÁRIO ----------
  app.get('/api/v1/ad-directory/users/:sid/groups', async (req, reply) => {
    const { sid } = SidParam.parse(req.params);
    const q = UserGroupsQuery.parse(req.query);

    const conditions: string[] = [`m.user_sid = '${sid.replace(/'/g, "''")}'`];
    if (q.onlyDirect) conditions.push('m.is_direct = true');
    if (q.q) {
      const safe = q.q.replace(/'/g, "''");
      conditions.push(
        `(COALESCE(g.display_name,'') ILIKE '%${safe}%' OR COALESCE(g.sam_account_name,'') ILIKE '%${safe}%' OR COALESCE(g.cn,'') ILIKE '%${safe}%' OR g.sid ILIKE '%${safe}%')`,
      );
    }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const rows = await deps.db.db.execute(sql`
      SELECT
        g.sid,
        COALESCE(g.display_name, g.cn, g.sam_account_name, g.sid) AS name,
        g.sam_account_name,
        g.description,
        g.scope,
        g.is_security,
        g.member_count,
        m.is_direct
      FROM ad_group_memberships m
      JOIN ad_groups g ON g.sid = m.group_sid
      ${sql.raw(whereClause)}
      ORDER BY m.is_direct DESC, COALESCE(g.display_name, g.cn, g.sam_account_name) ASC;
    `);

    reply.send({ items: rows.rows });
  });

  // ---------- SYNC: TRIGGER ----------
  app.post('/api/v1/ad-directory/sync', async (req, reply) => {
    if (!deps.runner) {
      reply.status(503).send({ message: 'LDAP não configurado — sync indisponível' });
      return;
    }
    const username = req.user.username;

    // Não bloqueia esperando o sync terminar — dispara e retorna 202.
    // O frontend faz polling em /sync/status.
    try {
      // Cria o registro 'running' sincronamente para que o erro 409 saia
      // imediatamente se já há sync em curso.
      const current = await getCurrentRunningSync(deps.db);
      if (current) {
        reply.status(409).send({ message: 'Já existe um sync em execução', syncId: current.id });
        return;
      }

      // Dispara em background. Erros são logados pelo runner.
      void deps.runner.runOnce(`manual:${username}` as `manual:${string}`).catch((err) => {
        if (err instanceof SyncAlreadyRunningError) return; // ignorado: outro processo pegou
        app.log.error({ err }, 'ad-sync: execução manual falhou');
      });

      await deps.db.db.insert(auditLog).values({
        actor: username,
        action: 'ad_directory_sync_triggered',
        details: null,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });

      reply.status(202).send({ ok: true });
    } catch (err) {
      app.log.error({ err }, 'ad-sync: falha ao disparar manual');
      reply.status(500).send({ message: 'Falha ao disparar sync' });
    }
  });

  // ---------- SYNC: STATUS ----------
  app.get('/api/v1/ad-directory/sync/status', async (_req, reply) => {
    const [currentRun, lastFinished] = await Promise.all([
      getCurrentRunningSync(deps.db),
      getLastFinishedSync(deps.db),
    ]);
    reply.send({
      enabled: deps.runner !== null,
      currentRun,
      lastSync: lastFinished,
    });
  });

  // ---------- SYNC: HISTÓRICO ----------
  app.get('/api/v1/ad-directory/sync/history', async (req, reply) => {
    const q = HistoryQuery.parse(req.query);
    const rows = await deps.db.db
      .select()
      .from(adDirectorySyncs)
      .orderBy(desc(adDirectorySyncs.startedAt))
      .limit(q.limit);
    reply.send({ items: rows });
  });
}
