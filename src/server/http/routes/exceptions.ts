import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbClient } from '@server/db/client.ts';
import { auditLog, exceptions } from '@server/db/schema.ts';

const ExceptionInput = z.object({
  scope: z.enum(['global', 'machine', 'tag']),
  scopeValue: z.string().max(255).nullable().optional(),
  matchKind: z.enum(['sid', 'sam', 'group']),
  matchValue: z.string().min(1).max(255),
  reason: z.string().min(1).max(500),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export async function registerExceptionsRoutes(
  app: FastifyInstance,
  deps: { db: DbClient },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  app.get('/api/v1/exceptions', async (_req, reply) => {
    const items = await deps.db.db
      .select()
      .from(exceptions)
      .orderBy(desc(exceptions.createdAt));
    reply.send({ items });
  });

  app.post('/api/v1/exceptions', async (req, reply) => {
    const body = ExceptionInput.parse(req.body);
    if (body.scope !== 'global' && !body.scopeValue) {
      reply.status(400).send({ message: 'scopeValue obrigatório para escopo machine/tag' });
      return;
    }

    const [created] = await deps.db.db
      .insert(exceptions)
      .values({
        scope: body.scope,
        scopeValue: body.scopeValue ?? null,
        matchKind: body.matchKind,
        matchValue: body.matchValue,
        reason: body.reason,
        createdBy: req.user.username,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      })
      .returning();

    await deps.db.db.insert(auditLog).values({
      actor: req.user.username,
      action: 'exception_create',
      details: { id: created?.id, ...body },
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });

    reply.status(201).send({ item: created });
  });

  app.delete('/api/v1/exceptions/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await deps.db.db.delete(exceptions).where(eq(exceptions.id, id)).returning();
    if (result.length === 0) {
      reply.status(404).send({ message: 'Exceção não encontrada' });
      return;
    }
    await deps.db.db.insert(auditLog).values({
      actor: req.user.username,
      action: 'exception_delete',
      details: { id },
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    reply.send({ ok: true });
  });
}
