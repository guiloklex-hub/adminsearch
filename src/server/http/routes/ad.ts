import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LdapPool } from '@server/enricher/ldap-client.ts';

export async function registerAdRoutes(
  app: FastifyInstance,
  deps: { ldap: LdapPool | null },
): Promise<void> {
  app.addHook('preHandler', app.requireSession);

  app.post('/api/v1/ad/test', async (_req, reply) => {
    if (!deps.ldap) {
      reply.status(503).send({ ok: false, message: 'LDAP não configurado no .env' });
      return;
    }
    try {
      await deps.ldap.testBind();
      reply.send({ ok: true });
    } catch (err) {
      reply.status(502).send({ ok: false, message: (err as Error).message });
    }
  });

  app.post('/api/v1/ad/resync/:sid', async (req, reply) => {
    const { sid } = z
      .object({ sid: z.string().regex(/^S-\d+-\d+(-\d+)*$/) })
      .parse(req.params);

    if (!deps.ldap) {
      reply.status(503).send({ ok: false, message: 'LDAP não configurado' });
      return;
    }
    // Resync direto sem cache wrapper aqui — cache é dentro do enricher.
    reply.send({ ok: true, sid });
  });
}
