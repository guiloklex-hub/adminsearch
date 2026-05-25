import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { DbClient } from '@server/db/client.ts';
import type { LdapPool } from '@server/enricher/ldap-client.ts';
import authPlugin from '@server/http/plugins/auth.ts';
import { registerErrorHandler } from '@server/http/plugins/error-handler.ts';
import { registerAdRoutes } from '@server/http/routes/ad.ts';
import { registerAuthRoutes } from '@server/http/routes/auth.ts';
import { registerEventsRoutes } from '@server/http/routes/events.ts';
import { registerExceptionsRoutes } from '@server/http/routes/exceptions.ts';
import { registerExportRoutes } from '@server/http/routes/export.ts';
import { registerFindingsRoutes } from '@server/http/routes/findings.ts';
import { registerHealthz } from '@server/http/routes/healthz.ts';
import { registerIngestRoute } from '@server/http/routes/ingest.ts';
import { registerInstitutionalGroupsRoutes } from '@server/http/routes/institutional-groups.ts';
import { registerMachinesRoutes } from '@server/http/routes/machines.ts';
import {
  registerRemediationResultRoute,
  registerRemediationRoutes,
} from '@server/http/routes/remediation.ts';
import { registerSeverityPoliciesRoutes } from '@server/http/routes/severity-policies.ts';
import { registerStatsRoutes } from '@server/http/routes/stats.ts';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BuildAppOptions {
  db: DbClient;
  ldap: LdapPool | null;
  logger: FastifyBaseLogger;
  jwtSecret: string;
  ingestToken: string;
  staleAgentDays: number;
  remediationMaxPerDispatch: number;
  remediationPlanRatePerMin: number;
  cookieSecure: boolean;
  cookieDomain?: string | undefined;
  staticDir?: string;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: opts.logger,
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  registerErrorHandler(app);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true },
  });

  await app.register(authPlugin, {
    jwtSecret: opts.jwtSecret,
    cookieSecure: opts.cookieSecure,
    cookieDomain: opts.cookieDomain,
  });

  await app.register(fastifyRateLimit, {
    global: false,
    max: 60,
    timeWindow: '1 minute',
  });

  await registerHealthz(app, { db: opts.db });
  await registerAuthRoutes(app, {
    db: opts.db,
    cookieSecure: opts.cookieSecure,
    cookieDomain: opts.cookieDomain,
  });
  await registerIngestRoute(app, {
    db: opts.db,
    ingestToken: opts.ingestToken,
    remediationMaxPerDispatch: opts.remediationMaxPerDispatch,
  });
  await registerRemediationResultRoute(app, { db: opts.db, ingestToken: opts.ingestToken });

  // Rotas autenticadas — encapsuladas em scope próprio porque adicionam
  // preHandler global de sessão.
  await app.register(async (scope) => {
    await registerMachinesRoutes(scope, { db: opts.db });
  });
  await app.register(async (scope) => {
    await registerRemediationRoutes(scope, {
      db: opts.db,
      planRatePerMin: opts.remediationPlanRatePerMin,
    });
  });
  await app.register(async (scope) => {
    await registerFindingsRoutes(scope, { db: opts.db });
  });
  await app.register(async (scope) => {
    await registerEventsRoutes(scope, { db: opts.db });
  });
  await app.register(async (scope) => {
    await registerStatsRoutes(scope, { db: opts.db, staleAgentDays: opts.staleAgentDays });
  });
  await app.register(async (scope) => {
    await registerExceptionsRoutes(scope, { db: opts.db });
  });
  await app.register(async (scope) => {
    await registerSeverityPoliciesRoutes(scope, { db: opts.db });
  });
  await app.register(async (scope) => {
    await registerInstitutionalGroupsRoutes(scope, { db: opts.db });
  });
  await app.register(async (scope) => {
    await registerExportRoutes(scope, { db: opts.db });
  });
  await app.register(async (scope) => {
    await registerAdRoutes(scope, { ldap: opts.ldap });
  });

  // Front estático (build do Vite)
  const staticDir = opts.staticDir ?? resolve(__dirname, '../../../dist/web');
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      wildcard: false,
    });
    // SPA fallback — qualquer rota que não bater em /api retorna index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/healthz')) {
        reply.status(404).send({ message: 'Não encontrado' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}
