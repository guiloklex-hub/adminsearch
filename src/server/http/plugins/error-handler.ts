import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      req.log.warn({ issues: err.issues }, 'payload inválido');
      reply.status(400).send({
        message: 'Payload inválido',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'erro interno');
    } else {
      req.log.warn({ err: { message: err.message, statusCode: status } }, 'erro de aplicação');
    }

    reply.status(status).send({
      message: status >= 500 ? 'Erro interno' : err.message,
    });
  });
}
