import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@server/db/client.ts';

export async function registerHealthz(app: FastifyInstance, deps: { db: DbClient }): Promise<void> {
  app.get('/healthz', async (_req, reply) => {
    try {
      await deps.db.pool.query('SELECT 1');
      reply.send({ status: 'ok' });
    } catch (err) {
      reply.status(503).send({ status: 'db_error', message: (err as Error).message });
    }
  });
}
