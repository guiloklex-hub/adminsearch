import argon2 from 'argon2';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbClient } from '@server/db/client.ts';
import { admins, auditLog } from '@server/db/schema.ts';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '@server/http/plugins/auth.ts';

const ARGON_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

const LoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(8).max(256),
});

const SetupSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(12).max(256),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: { db: DbClient; cookieSecure: boolean; cookieDomain?: string | undefined },
): Promise<void> {
  const { db } = deps;

  // GET /api/v1/auth/setup-required — informa se ainda não há admin cadastrado
  app.get('/api/v1/auth/setup-required', async (_req, reply) => {
    const [row] = await db.db.select({ c: count() }).from(admins);
    reply.send({ setupRequired: (row?.c ?? 0) === 0 });
  });

  // POST /api/v1/auth/setup — cria o primeiro admin (só funciona se a tabela estiver vazia)
  app.post(
    '/api/v1/auth/setup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { username, password } = SetupSchema.parse(req.body);
      const [row] = await db.db.select({ c: count() }).from(admins);
      if ((row?.c ?? 0) > 0) {
        reply.status(409).send({ message: 'Admin já cadastrado' });
        return;
      }

      const passwordHash = await argon2.hash(password, ARGON_OPTS);
      const [inserted] = await db.db
        .insert(admins)
        .values({ username, passwordHash })
        .returning({ id: admins.id, username: admins.username });

      await db.db.insert(auditLog).values({
        actor: username,
        action: 'setup',
        details: { username },
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });

      if (!inserted) {
        reply.status(500).send({ message: 'Falha ao criar admin' });
        return;
      }

      const token = await reply.jwtSign({ sub: inserted.id, username: inserted.username });
      reply
        .setCookie(
          SESSION_COOKIE_NAME,
          token,
          sessionCookieOptions({ secure: deps.cookieSecure, domain: deps.cookieDomain }),
        )
        .send({ username: inserted.username });
    },
  );

  // POST /api/v1/auth/login
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { username, password } = LoginSchema.parse(req.body);

      // Mensagens indistintas para evitar enumeração.
      const admin = await db.db.query.admins.findFirst({ where: eq(admins.username, username) });
      const fakeHash = '$argon2id$v=19$m=65536,t=3,p=1$YWFhYWFhYWFhYWFhYWFhYQ$abcdefghijklmnop';
      const hash = admin?.passwordHash ?? fakeHash;
      const ok = await argon2.verify(hash, password).catch(() => false);

      if (!admin || !ok) {
        await db.db.insert(auditLog).values({
          actor: username,
          action: 'login_failed',
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        reply.status(401).send({ message: 'Credenciais inválidas' });
        return;
      }

      await db.db
        .update(admins)
        .set({ lastLoginAt: new Date(), updatedAt: new Date() })
        .where(eq(admins.id, admin.id));

      await db.db.insert(auditLog).values({
        actor: admin.username,
        action: 'login',
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });

      const token = await reply.jwtSign({ sub: admin.id, username: admin.username });
      reply
        .setCookie(
          SESSION_COOKIE_NAME,
          token,
          sessionCookieOptions({ secure: deps.cookieSecure, domain: deps.cookieDomain }),
        )
        .send({ username: admin.username });
    },
  );

  // POST /api/v1/auth/logout
  app.post('/api/v1/auth/logout', { preHandler: app.requireSession }, async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    await db.db.insert(auditLog).values({
      actor: req.user.username,
      action: 'logout',
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    reply.send({ ok: true });
  });

  // GET /api/v1/auth/me
  app.get('/api/v1/auth/me', { preHandler: app.requireSession }, async (req, reply) => {
    reply.send({ username: req.user.username });
  });

  // POST /api/v1/auth/change-password
  app.post(
    '/api/v1/auth/change-password',
    { preHandler: app.requireSession },
    async (req, reply) => {
      const { currentPassword, newPassword } = ChangePasswordSchema.parse(req.body);
      const admin = await db.db.query.admins.findFirst({
        where: eq(admins.id, req.user.sub),
      });
      if (!admin) {
        reply.status(401).send({ message: 'Não autorizado' });
        return;
      }
      const ok = await argon2.verify(admin.passwordHash, currentPassword).catch(() => false);
      if (!ok) {
        reply.status(401).send({ message: 'Senha atual incorreta' });
        return;
      }
      const newHash = await argon2.hash(newPassword, ARGON_OPTS);
      await db.db
        .update(admins)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(eq(admins.id, admin.id));
      await db.db.insert(auditLog).values({
        actor: admin.username,
        action: 'change_password',
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      reply.send({ ok: true });
    },
  );
}
