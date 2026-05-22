import { and, desc, eq, ilike, inArray, lt, max, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbClient } from '@server/db/client.ts';
import { effectiveMembers, findingsEvents, machines, scanRuns } from '@server/db/schema.ts';

const ListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(64).optional(),
  domain: z.string().trim().max(255).optional(),
  severity: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined)),
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

    const filters = [];
    if (q.q) {
      filters.push(
        or(
          ilike(machines.dnsHostName, `%${q.q}%`),
          ilike(machines.netBiosName, `%${q.q}%`),
          ilike(machines.lastLoggedUser, `%${q.q}%`),
        ),
      );
    }
    if (q.domain) filters.push(eq(machines.domain, q.domain));
    if (q.tag) filters.push(sql`${q.tag} = ANY(${machines.tags})`);
    if (q.staleDays) {
      const cutoff = new Date(now.getTime() - q.staleDays * 86400_000);
      filters.push(lt(machines.lastSeenAt, cutoff));
    }

    const where = filters.length ? and(...filters) : undefined;

    const rowsQuery = deps.db.db
      .select({
        id: machines.id,
        dnsHostName: machines.dnsHostName,
        netBiosName: machines.netBiosName,
        domain: machines.domain,
        osCaption: machines.osCaption,
        osVersion: machines.osVersion,
        tags: machines.tags,
        lastSeenAt: machines.lastSeenAt,
        lastLoggedUser: machines.lastLoggedUser,
      })
      .from(machines)
      .orderBy(desc(machines.lastSeenAt))
      .limit(q.pageSize)
      .offset(offset);

    const totalQuery = deps.db.db
      .select({ c: sql<number>`count(*)::int` })
      .from(machines);

    const rows = await (where ? rowsQuery.where(where) : rowsQuery);
    const [total] = await (where ? totalQuery.where(where) : totalQuery);

    // Para cada máquina, pegar a severidade máxima do último scan e contagem de admins
    const machineIds = rows.map((r) => r.id);
    let summary: Record<string, { maxSeverity: string; adminCount: number }> = {};
    if (machineIds.length > 0) {
      const latest = await deps.db.db.execute(sql`
        WITH latest_scan AS (
          SELECT DISTINCT ON (machine_id) machine_id, id
          FROM scan_runs
          WHERE machine_id = ANY(${sql.raw(`ARRAY[${machineIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})
            AND expansion_status = 'done'
          ORDER BY machine_id, collected_at DESC
        )
        SELECT em.machine_id,
               COUNT(*)::int AS admin_count,
               MAX(CASE em.severity
                     WHEN 'critical' THEN 4
                     WHEN 'high' THEN 3
                     WHEN 'medium' THEN 2
                     WHEN 'low' THEN 1
                     ELSE 0
                   END) AS max_severity_rank
        FROM effective_members em
        JOIN latest_scan ls ON ls.id = em.scan_run_id
        GROUP BY em.machine_id;
      `);

      const ranks = ['info', 'low', 'medium', 'high', 'critical'];
      for (const r of latest.rows as Array<{
        machine_id: string;
        admin_count: number;
        max_severity_rank: number;
      }>) {
        summary[r.machine_id] = {
          maxSeverity: ranks[r.max_severity_rank] ?? 'info',
          adminCount: r.admin_count,
        };
      }
    }

    let result = rows.map((r) => ({
      ...r,
      maxSeverity: summary[r.id]?.maxSeverity ?? null,
      adminCount: summary[r.id]?.adminCount ?? 0,
    }));

    if (q.severity && q.severity.length > 0) {
      const minRank = Math.min(...q.severity.map((s) => SEVERITY_RANK[s] ?? 99));
      result = result.filter((r) =>
        r.maxSeverity ? (SEVERITY_RANK[r.maxSeverity] ?? -1) >= minRank : false,
      );
    }

    reply.send({
      items: result,
      total: total?.c ?? 0,
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

    const admins = latestScan
      ? await deps.db.db
          .select()
          .from(effectiveMembers)
          .where(eq(effectiveMembers.scanRunId, latestScan.id))
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

    reply.send({ machine, latestScan, admins, events, scanHistory });
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
