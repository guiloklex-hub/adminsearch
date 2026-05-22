import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbClient } from '@server/db/client.ts';
import { findingsEvents, machines } from '@server/db/schema.ts';

const EventsQuery = z.object({
  machineId: z.string().uuid().optional(),
  kind: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined)),
  sinceDays: z.coerce.number().int().min(1).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

export async function registerEventsRoutes(
  app: FastifyInstance,
  deps: { db: DbClient },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  app.get('/api/v1/events', async (req, reply) => {
    const q = EventsQuery.parse(req.query);

    const filters = [];
    if (q.machineId) filters.push(eq(findingsEvents.machineId, q.machineId));
    if (q.kind && q.kind.length > 0) filters.push(inArray(findingsEvents.kind, q.kind));
    if (q.sinceDays) {
      const cutoff = new Date(Date.now() - q.sinceDays * 86400_000);
      filters.push(gte(findingsEvents.occurredAt, cutoff));
    }

    const items = await deps.db.db
      .select({
        id: findingsEvents.id,
        machineId: findingsEvents.machineId,
        hostName: machines.dnsHostName,
        occurredAt: findingsEvents.occurredAt,
        kind: findingsEvents.kind,
        sid: findingsEvents.sid,
        name: findingsEvents.name,
        details: findingsEvents.details,
      })
      .from(findingsEvents)
      .innerJoin(machines, eq(machines.id, findingsEvents.machineId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(findingsEvents.occurredAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);

    const [totalRow] = await deps.db.db
      .select({ c: sql<number>`count(*)::int` })
      .from(findingsEvents)
      .innerJoin(machines, eq(machines.id, findingsEvents.machineId))
      .where(filters.length ? and(...filters) : undefined);

    reply.send({ items, total: totalRow?.c ?? 0, page: q.page, pageSize: q.pageSize });
  });
}
