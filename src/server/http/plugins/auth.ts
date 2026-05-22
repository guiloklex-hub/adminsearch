import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; username: string };
    user: { sub: string; username: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    requireSession: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

interface AuthPluginOptions {
  jwtSecret: string;
  cookieSecure: boolean;
  cookieDomain?: string | undefined;
}

const SESSION_COOKIE = 'adminsearch_session';

async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  await app.register(fastifyCookie);

  await app.register(fastifyJwt, {
    secret: opts.jwtSecret,
    cookie: {
      cookieName: SESSION_COOKIE,
      signed: false,
    },
    sign: { expiresIn: '12h' },
  });

  app.decorate('requireSession', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.status(401).send({ message: 'Não autorizado' });
    }
  });
}

export default fp(authPlugin, { name: 'auth' });

export const sessionCookieOptions = (opts: { secure: boolean; domain?: string | undefined }) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: opts.secure,
  domain: opts.domain,
  maxAge: 60 * 60 * 12,
});

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
