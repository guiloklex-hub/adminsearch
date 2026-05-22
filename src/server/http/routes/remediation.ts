import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbClient } from '@server/db/client.ts';
import { machines, remediationActions } from '@server/db/schema.ts';
import { cancel } from '@server/remediation/cancel.ts';
import { confirm } from '@server/remediation/confirm.ts';
import { PlanRefused, plan } from '@server/remediation/plan.ts';
import { applyResults } from '@server/remediation/result.ts';
import { timingSafeEquals } from '@server/utils/timing-safe.ts';
import { ActionResultPayloadSchema } from '@shared/ingest-contract.ts';

const PlanInput = z.object({
  machineId: z.string().uuid(),
  targetSid: z.string().regex(/^S-\d+-\d+(-\d+)*$/),
  reason: z.string().trim().max(500).optional(),
});

const CancelInput = z.object({
  reason: z.string().trim().min(1).max(500),
});

const ListQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined)),
  machineId: z.string().uuid().optional(),
  sinceDays: z.coerce.number().int().min(1).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Endpoints autenticados por sessão (Web UI). O endpoint `/result` é separado
 * (autenticado por Bearer do agente) e registrado em `registerRemediationAgentRoutes`.
 */
export async function registerRemediationRoutes(
  app: FastifyInstance,
  deps: { db: DbClient; planRatePerMin: number },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  // POST /api/v1/remediation/plan
  app.post(
    '/api/v1/remediation/plan',
    { config: { rateLimit: { max: deps.planRatePerMin, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = PlanInput.parse(req.body);
      try {
        const result = await plan(
          { db: deps.db },
          {
            actor: req.user.username,
            machineId: body.machineId,
            targetSid: body.targetSid,
            reason: body.reason ?? null,
            requestIp: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          },
        );
        reply.status(201).send(result);
      } catch (err) {
        if (err instanceof PlanRefused) {
          reply.status(err.status).send({ message: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // POST /api/v1/remediation/:id/confirm
  app.post('/api/v1/remediation/:id/confirm', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      const result = await confirm(
        { db: deps.db },
        {
          actor: req.user.username,
          actionId: id,
          requestIp: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        },
      );
      reply.send(result);
    } catch (err) {
      if (err instanceof PlanRefused) {
        reply.status(err.status).send({ message: err.message });
        return;
      }
      throw err;
    }
  });

  // POST /api/v1/remediation/:id/cancel
  app.post('/api/v1/remediation/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = CancelInput.parse(req.body);
    try {
      const result = await cancel(
        { db: deps.db },
        {
          actor: req.user.username,
          actionId: id,
          reason: body.reason,
          requestIp: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        },
      );
      reply.send(result);
    } catch (err) {
      if (err instanceof PlanRefused) {
        reply.status(err.status).send({ message: err.message });
        return;
      }
      throw err;
    }
  });

  // GET /api/v1/remediation
  app.get('/api/v1/remediation', async (req, reply) => {
    const q = ListQuery.parse(req.query);
    const filters = [];
    if (q.status && q.status.length > 0)
      filters.push(inArray(remediationActions.status, q.status));
    if (q.machineId) filters.push(eq(remediationActions.machineId, q.machineId));
    if (q.sinceDays) {
      const cutoff = new Date(Date.now() - q.sinceDays * 86400_000);
      filters.push(gte(remediationActions.plannedAt, cutoff));
    }

    const items = await deps.db.db
      .select({
        id: remediationActions.id,
        machineId: remediationActions.machineId,
        hostName: machines.dnsHostName,
        targetSid: remediationActions.targetSid,
        targetName: remediationActions.targetName,
        targetSource: remediationActions.targetSource,
        viaGroup: remediationActions.viaGroup,
        status: remediationActions.status,
        plannedBy: remediationActions.plannedBy,
        plannedAt: remediationActions.plannedAt,
        plannedReason: remediationActions.plannedReason,
        confirmedBy: remediationActions.confirmedBy,
        confirmedAt: remediationActions.confirmedAt,
        cancelledBy: remediationActions.cancelledBy,
        cancelledAt: remediationActions.cancelledAt,
        cancelReason: remediationActions.cancelReason,
        dispatchedAt: remediationActions.dispatchedAt,
        executedAt: remediationActions.executedAt,
        executionResult: remediationActions.executionResult,
        executionError: remediationActions.executionError,
      })
      .from(remediationActions)
      .innerJoin(machines, eq(machines.id, remediationActions.machineId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(remediationActions.plannedAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);

    const [total] = await deps.db.db
      .select({ c: sql<number>`count(*)::int` })
      .from(remediationActions)
      .where(filters.length ? and(...filters) : undefined);

    reply.send({ items, total: total?.c ?? 0, page: q.page, pageSize: q.pageSize });
  });

  // GET /api/v1/remediation/:id
  app.get('/api/v1/remediation/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await deps.db.db
      .select({
        action: remediationActions,
        hostName: machines.dnsHostName,
      })
      .from(remediationActions)
      .innerJoin(machines, eq(machines.id, remediationActions.machineId))
      .where(eq(remediationActions.id, id))
      .limit(1);
    if (row.length === 0) {
      reply.status(404).send({ message: 'Ação não encontrada' });
      return;
    }
    reply.send(row[0]);
  });
}

/**
 * Endpoint público autenticado por Bearer (mesmo `INGEST_TOKEN` do /ingest).
 * Recebe os resultados das ações de remediação executadas pelo agente.
 */
export async function registerRemediationResultRoute(
  app: FastifyInstance,
  deps: { db: DbClient; ingestToken: string },
): Promise<void> {
  app.post(
    '/api/v1/remediation/result',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      bodyLimit: 64 * 1024,
    },
    async (req, reply) => {
      const auth = req.headers.authorization ?? '';
      const m = /^Bearer\s+(.+)$/.exec(auth);
      if (!m || !timingSafeEquals(m[1] ?? '', deps.ingestToken)) {
        reply.status(401).send({ message: 'Não autorizado' });
        return;
      }

      const payload = ActionResultPayloadSchema.parse(req.body);
      const out = await applyResults(
        { db: deps.db, agentIp: req.ip, userAgent: req.headers['user-agent'] ?? null },
        payload.scanId,
        payload.results,
      );
      req.log.info(
        { scanId: payload.scanId, applied: out.applied, ignored: out.ignored },
        'resultados de remediação recebidos',
      );
      reply.status(202).send(out);
    },
  );
}
