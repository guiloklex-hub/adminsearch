import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbClient } from '@server/db/client.ts';
import { adUsers, effectiveMembers, machines, scanRuns } from '@server/db/schema.ts';

const FindingsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  severity: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined)),
  source: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined)),
  viaGroup: z.string().trim().max(255).optional(),
  hideExceptions: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : v ?? false)),
  onlyOrphans: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : v ?? false)),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * Endpoint principal — só lista os achados da última scan `done` de cada
 * máquina, para evitar duplicar usuários ao longo do histórico.
 */
export async function registerFindingsRoutes(
  app: FastifyInstance,
  deps: { db: DbClient },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  app.get('/api/v1/findings', async (req, reply) => {
    const q = FindingsQuery.parse(req.query);

    const filters = [];
    if (q.severity && q.severity.length > 0) {
      filters.push(inArray(effectiveMembers.severity, q.severity));
    }
    if (q.source && q.source.length > 0) {
      filters.push(inArray(effectiveMembers.source, q.source));
    }
    if (q.viaGroup) filters.push(eq(effectiveMembers.viaGroup, q.viaGroup));
    if (q.hideExceptions) filters.push(isNull(effectiveMembers.matchedExceptionId));
    if (q.onlyOrphans) filters.push(eq(effectiveMembers.source, 'ORPHAN_SID'));
    if (q.q) {
      filters.push(
        or(
          ilike(effectiveMembers.name, `%${q.q}%`),
          ilike(effectiveMembers.sid, `%${q.q}%`),
          ilike(effectiveMembers.viaGroup, `%${q.q}%`),
          ilike(machines.dnsHostName, `%${q.q}%`),
        ),
      );
    }

    const limit = q.pageSize;
    const offset = (q.page - 1) * limit;

    const baseQuery = deps.db.db
      .select({
        id: effectiveMembers.id,
        machineId: effectiveMembers.machineId,
        hostName: machines.dnsHostName,
        sid: effectiveMembers.sid,
        name: effectiveMembers.name,
        source: effectiveMembers.source,
        viaGroup: effectiveMembers.viaGroup,
        viaGroupSid: effectiveMembers.viaGroupSid,
        adEnabled: effectiveMembers.adEnabled,
        severity: effectiveMembers.severity,
        matchedExceptionId: effectiveMembers.matchedExceptionId,
        scanCollectedAt: scanRuns.collectedAt,
      })
      .from(effectiveMembers)
      .innerJoin(
        scanRuns,
        and(
          eq(scanRuns.id, effectiveMembers.scanRunId),
          sql`scan_runs.id = (
            SELECT id FROM scan_runs s2
            WHERE s2.machine_id = scan_runs.machine_id
              AND s2.expansion_status = 'done'
            ORDER BY s2.collected_at DESC
            LIMIT 1
          )`,
        ),
      )
      .innerJoin(machines, eq(machines.id, effectiveMembers.machineId))
      .where(filters.length ? and(...filters) : undefined);

    const items = await baseQuery
      .orderBy(desc(sql`CASE ${effectiveMembers.severity}
        WHEN 'critical' THEN 4
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 1
        ELSE 0
      END`))
      .limit(limit)
      .offset(offset);

    // Conta total para paginação
    const [totalRow] = await deps.db.db
      .select({ c: sql<number>`count(*)::int` })
      .from(effectiveMembers)
      .innerJoin(
        scanRuns,
        and(
          eq(scanRuns.id, effectiveMembers.scanRunId),
          sql`scan_runs.id = (
            SELECT id FROM scan_runs s2
            WHERE s2.machine_id = scan_runs.machine_id
              AND s2.expansion_status = 'done'
            ORDER BY s2.collected_at DESC
            LIMIT 1
          )`,
        ),
      )
      .innerJoin(machines, eq(machines.id, effectiveMembers.machineId))
      .where(filters.length ? and(...filters) : undefined);

    reply.send({ items, total: totalRow?.c ?? 0, page: q.page, pageSize: q.pageSize });
  });

  // GET /api/v1/findings/by-user
  app.get('/api/v1/findings/by-user', async (req, reply) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(50),
        // backward compat: se cliente antigo manda limit, usa como pageSize
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        source: z
          .string()
          .optional()
          .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined)),
        hideExceptions: z
          .union([z.boolean(), z.string()])
          .optional()
          .transform((v) => (typeof v === 'string' ? v === 'true' : v ?? false)),
        hideServiceAccounts: z
          .union([z.boolean(), z.string()])
          .optional()
          .transform((v) => (typeof v === 'string' ? v === 'true' : v ?? false)),
        onlyEnabled: z
          .union([z.boolean(), z.string()])
          .optional()
          .transform((v) => (typeof v === 'string' ? v === 'true' : v ?? false)),
        onlyDirect: z
          .union([z.boolean(), z.string()])
          .optional()
          .transform((v) => (typeof v === 'string' ? v === 'true' : v ?? false)),
        q: z.string().trim().max(120).optional(),
      })
      .parse(req.query);

    // Builder dinâmico de WHERE — colocamos em SQL bruto pra clareza
    const conditions: string[] = ["em.source IS NOT NULL"];
    if (q.source && q.source.length > 0) {
      const safeSources = q.source
        .filter((s) => /^[A-Z_]+$/.test(s))
        .map((s) => `'${s}'`)
        .join(',');
      if (safeSources) conditions.push(`em.source IN (${safeSources})`);
    }
    if (q.hideExceptions) conditions.push('em.matched_exception_id IS NULL');
    if (q.hideServiceAccounts) conditions.push('COALESCE(em.is_service_account, false) = false');
    if (q.onlyEnabled) conditions.push('COALESCE(em.ad_enabled, true) = true');
    if (q.q) {
      const safe = q.q.replace(/'/g, "''");
      conditions.push(
        `(COALESCE(au.display_name,'') ILIKE '%${safe}%' OR COALESCE(au.sam_account_name,'') ILIKE '%${safe}%' OR COALESCE(au.email,'') ILIKE '%${safe}%' OR COALESCE(au.department,'') ILIKE '%${safe}%' OR em.sid ILIKE '%${safe}%')`,
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const havingClause = q.onlyDirect
      ? 'HAVING COUNT(DISTINCT CASE WHEN em.via_group IS NULL THEN em.machine_id END) > 0'
      : '';
    const pageSize = q.limit ?? q.pageSize;
    const offset = (q.page - 1) * pageSize;

    // Conta total (para paginação)
    const totalRows = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      ),
      grouped AS (
        SELECT em.sid
        FROM effective_members em
        JOIN latest_scan ls ON ls.id = em.scan_run_id
        LEFT JOIN ad_users au ON au.sid = em.sid
        ${sql.raw(whereClause)}
        GROUP BY em.sid, au.display_name, em.name, au.sam_account_name, au.user_principal_name,
                 au.email, au.department, au.title, au.enabled, au.is_service_account, au.last_logon,
                 em.source
        ${sql.raw(havingClause)}
      )
      SELECT COUNT(*)::int AS total FROM grouped;
    `);
    const total = (totalRows.rows[0] as { total: number } | undefined)?.total ?? 0;

    const rows = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      )
      SELECT em.sid,
             COALESCE(au.display_name, em.name, em.sid) AS name,
             au.sam_account_name,
             au.user_principal_name,
             au.email,
             au.department,
             au.title,
             au.enabled AS ad_enabled,
             au.is_service_account,
             au.last_logon,
             em.source,
             BOOL_OR(em.matched_exception_id IS NOT NULL) AS has_exception,
             COUNT(DISTINCT em.machine_id)::int AS machine_count,
             SUM(CASE WHEN em.severity='critical' THEN 1 ELSE 0 END)::int AS critical_count,
             SUM(CASE WHEN em.severity='high' THEN 1 ELSE 0 END)::int AS high_count,
             SUM(CASE WHEN em.severity='medium' THEN 1 ELSE 0 END)::int AS medium_count,
             SUM(CASE WHEN em.via_group IS NOT NULL THEN 1 ELSE 0 END)::int AS via_group_count,
             COUNT(DISTINCT CASE WHEN em.via_group IS NULL THEN em.machine_id END)::int AS direct_machine_count
      FROM effective_members em
      JOIN latest_scan ls ON ls.id = em.scan_run_id
      LEFT JOIN ad_users au ON au.sid = em.sid
      ${sql.raw(whereClause)}
      GROUP BY em.sid, au.display_name, em.name, au.sam_account_name, au.user_principal_name,
               au.email, au.department, au.title, au.enabled, au.is_service_account, au.last_logon,
               em.source
      ${sql.raw(havingClause)}
      ORDER BY machine_count DESC, name ASC
      LIMIT ${pageSize}
      OFFSET ${offset};
    `);

    reply.send({ items: rows.rows, total, page: q.page, pageSize });
  });

  // GET /api/v1/findings/users/:sid/machines — drill-down: máquinas onde este SID é admin
  app.get('/api/v1/findings/users/:sid/machines', async (req, reply) => {
    const { sid } = z
      .object({ sid: z.string().regex(/^S-\d+-\d+(-\d+)*$/) })
      .parse(req.params);

    const rows = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id, collected_at
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      )
      SELECT m.id AS machine_id,
             m.dns_host_name AS host_name,
             m.domain,
             m.last_logged_user,
             m.last_seen_at,
             em.via_group,
             em.severity,
             em.matched_exception_id IS NOT NULL AS has_exception
      FROM effective_members em
      JOIN latest_scan ls ON ls.id = em.scan_run_id
      JOIN machines m ON m.id = em.machine_id
      WHERE em.sid = ${sid}
      ORDER BY m.dns_host_name;
    `);

    reply.send({ items: rows.rows });
  });

  // GET /api/v1/findings/by-group
  app.get('/api/v1/findings/by-group', async (req, reply) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(50),
      })
      .parse(req.query);

    const offset = (q.page - 1) * q.pageSize;

    const totalRow = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      )
      SELECT COUNT(DISTINCT em.via_group)::int AS total
      FROM effective_members em
      JOIN latest_scan ls ON ls.id = em.scan_run_id
      WHERE em.via_group IS NOT NULL;
    `);
    const total = (totalRow.rows[0] as { total: number } | undefined)?.total ?? 0;

    const rows = await deps.db.db.execute(sql`
      WITH latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
        ORDER BY machine_id, collected_at DESC
      )
      SELECT em.via_group AS group_name,
             em.via_group_sid AS group_sid,
             COUNT(DISTINCT em.sid)::int AS user_count,
             COUNT(DISTINCT em.machine_id)::int AS machine_count
      FROM effective_members em
      JOIN latest_scan ls ON ls.id = em.scan_run_id
      WHERE em.via_group IS NOT NULL
      GROUP BY em.via_group, em.via_group_sid
      ORDER BY machine_count DESC
      LIMIT ${q.pageSize}
      OFFSET ${offset};
    `);

    reply.send({ items: rows.rows, total, page: q.page, pageSize: q.pageSize });
  });
}

// Mantém imports que o lint poderia podar
export { isNotNull, count, adUsers };
