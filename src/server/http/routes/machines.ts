import type { DbClient } from '@server/db/client.ts';
import { effectiveMembers, findingsEvents, machines, scanRuns } from '@server/db/schema.ts';
import { type MemberSource, explainSeverity } from '@server/enricher/severity.ts';
import { and, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type Severity = (typeof SEVERITY_VALUES)[number];

const ListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(64).optional(),
  domain: z.string().trim().max(255).optional(),
  severity: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter((s): s is Severity => (SEVERITY_VALUES as readonly string[]).includes(s))
        : undefined,
    ),
  staleDays: z.coerce.number().int().min(0).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const UpdateMachineSchema = z.object({
  tags: z.array(z.string().min(1).max(32)).max(32).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
const RANK_TO_NAME = ['info', 'low', 'medium', 'high', 'critical'] as const;

export async function registerMachinesRoutes(
  app: FastifyInstance,
  deps: { db: DbClient },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  // GET /api/v1/machines
  app.get('/api/v1/machines', async (req, reply) => {
    const q = ListQuery.parse(req.query);
    const offset = (q.page - 1) * q.pageSize;
    const now = new Date();

    const baseFilters: ReturnType<typeof sql>[] = [];
    if (q.q) {
      const pat = `%${q.q}%`;
      baseFilters.push(
        sql`(m.dns_host_name ILIKE ${pat} OR m.net_bios_name ILIKE ${pat} OR m.last_logged_user ILIKE ${pat})`,
      );
    }
    if (q.domain) baseFilters.push(sql`m.domain = ${q.domain}`);
    if (q.tag) baseFilters.push(sql`${q.tag} = ANY(m.tags)`);
    if (q.staleDays) {
      const cutoff = new Date(now.getTime() - q.staleDays * 86400_000);
      baseFilters.push(sql`m.last_seen_at < ${cutoff}`);
    }

    const baseWhere = baseFilters.length ? sql`WHERE ${sql.join(baseFilters, sql` AND `)}` : sql``;

    // Filtro de severidade: OR exato sobre o max_rank computado por máquina.
    // Aplicado em SQL antes de LIMIT/OFFSET para que o total reflita o filtro.
    const ranks =
      q.severity?.map((s) => SEVERITY_RANK[s]).filter((r): r is number => r != null) ?? [];
    const severityWhere =
      ranks.length > 0
        ? sql`WHERE COALESCE(s.max_rank, -1) IN (${sql.join(
            ranks.map((r) => sql`${r}`),
            sql`, `,
          )})`
        : sql``;

    const result = await deps.db.db.execute(sql`
      WITH base AS (
        SELECT m.id, m.dns_host_name, m.net_bios_name, m.domain, m.os_caption,
               m.os_version, m.tags, m.last_seen_at, m.last_logged_user
        FROM machines m
        ${baseWhere}
      ),
      latest_scan AS (
        SELECT DISTINCT ON (machine_id) machine_id, id
        FROM scan_runs
        WHERE expansion_status = 'done'
          AND machine_id IN (SELECT id FROM base)
        ORDER BY machine_id, collected_at DESC
      ),
      sev AS (
        SELECT em.machine_id,
               COUNT(*)::int AS admin_count,
               MAX(CASE em.severity
                     WHEN 'critical' THEN 4
                     WHEN 'high' THEN 3
                     WHEN 'medium' THEN 2
                     WHEN 'low' THEN 1
                     ELSE 0
                   END) AS max_rank
        FROM effective_members em
        JOIN latest_scan ls ON ls.id = em.scan_run_id
        GROUP BY em.machine_id
      ),
      enriched AS (
        SELECT b.*, COALESCE(s.admin_count, 0) AS admin_count, s.max_rank
        FROM base b
        LEFT JOIN sev s ON s.machine_id = b.id
        ${severityWhere}
      )
      SELECT *, COUNT(*) OVER ()::int AS total_count
      FROM enriched
      ORDER BY last_seen_at DESC
      LIMIT ${q.pageSize} OFFSET ${offset};
    `);

    const rows = result.rows as Array<{
      id: string;
      dns_host_name: string;
      net_bios_name: string;
      domain: string | null;
      os_caption: string | null;
      os_version: string | null;
      tags: string[] | null;
      last_seen_at: Date | string;
      last_logged_user: string | null;
      admin_count: number;
      max_rank: number | null;
      total_count: number;
    }>;

    const total = rows[0]?.total_count ?? 0;
    const items = rows.map((r) => ({
      id: r.id,
      dnsHostName: r.dns_host_name,
      netBiosName: r.net_bios_name,
      domain: r.domain,
      osCaption: r.os_caption,
      osVersion: r.os_version,
      tags: r.tags,
      lastSeenAt: r.last_seen_at,
      lastLoggedUser: r.last_logged_user,
      maxSeverity: r.max_rank != null ? RANK_TO_NAME[r.max_rank] : null,
      adminCount: r.admin_count ?? 0,
    }));

    reply.send({
      items,
      total,
      page: q.page,
      pageSize: q.pageSize,
    });
  });

  // GET /api/v1/machines/:id
  app.get('/api/v1/machines/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const machine = await deps.db.db.query.machines.findFirst({
      where: eq(machines.id, id),
    });
    if (!machine) {
      reply.status(404).send({ message: 'Máquina não encontrada' });
      return;
    }

    const latestScan = await deps.db.db.query.scanRuns.findFirst({
      where: and(eq(scanRuns.machineId, id), eq(scanRuns.expansionStatus, 'done')),
      orderBy: [desc(scanRuns.collectedAt)],
    });

    const rawAdmins = latestScan
      ? await deps.db.db
          .select()
          .from(effectiveMembers)
          .where(eq(effectiveMembers.scanRunId, latestScan.id))
      : [];

    const admins = rawAdmins.map((a) => ({
      ...a,
      severityReason: explainSeverity({
        sid: a.sid,
        source: a.source as MemberSource,
        viaGroup: a.viaGroup,
        viaGroupSid: a.viaGroupSid,
        adEnabled: a.adEnabled,
        isServiceAccount: a.isServiceAccount,
        hasMatchedException: a.matchedExceptionId !== null,
      }),
    }));

    const severityRank: Record<string, number> = {
      info: 0,
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };
    const rankedAdmins = [...admins].sort(
      (a, b) => (severityRank[b.severity] ?? -1) - (severityRank[a.severity] ?? -1),
    );
    const maxSeverity = rankedAdmins[0]?.severity ?? null;
    // Os "drivers" são as linhas que justificam a severity máxima da máquina —
    // tudo que está no topo do ranking (mesma severity do máximo).
    const severityDrivers = maxSeverity
      ? rankedAdmins
          .filter((a) => a.severity === maxSeverity)
          .slice(0, 5)
          .map((a) => ({
            sid: a.sid,
            name: a.name,
            viaGroup: a.viaGroup,
            reason: a.severityReason,
          }))
      : [];

    const events = await deps.db.db
      .select()
      .from(findingsEvents)
      .where(eq(findingsEvents.machineId, id))
      .orderBy(desc(findingsEvents.occurredAt))
      .limit(50);

    const scanHistory = await deps.db.db
      .select({
        id: scanRuns.id,
        collectedAt: scanRuns.collectedAt,
        receivedAt: scanRuns.receivedAt,
        source: scanRuns.source,
        agentVersion: scanRuns.agentVersion,
        totalRawMembers: scanRuns.totalRawMembers,
        expansionStatus: scanRuns.expansionStatus,
        expansionError: scanRuns.expansionError,
      })
      .from(scanRuns)
      .where(eq(scanRuns.machineId, id))
      .orderBy(desc(scanRuns.collectedAt))
      .limit(20);

    reply.send({
      machine,
      latestScan,
      admins,
      maxSeverity,
      severityDrivers,
      events,
      scanHistory,
    });
  });

  // PATCH /api/v1/machines/:id
  app.patch('/api/v1/machines/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateMachineSchema.parse(req.body);

    const update: Record<string, unknown> = {};
    if (body.tags !== undefined) update.tags = body.tags;
    if (body.notes !== undefined) update.notes = body.notes;

    if (Object.keys(update).length === 0) {
      reply.send({ ok: true, changed: false });
      return;
    }

    const result = await deps.db.db
      .update(machines)
      .set(update)
      .where(eq(machines.id, id))
      .returning({ id: machines.id });

    if (result.length === 0) {
      reply.status(404).send({ message: 'Máquina não encontrada' });
      return;
    }

    reply.send({ ok: true, changed: true });
  });
}

// Manter import usado quando o build não otimiza tree-shaking
export { inArray, max };
