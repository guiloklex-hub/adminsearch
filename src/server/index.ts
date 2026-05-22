import { createDb } from '@server/db/client.ts';
import { runMigrations } from '@server/db/migrate.ts';
import { Enricher } from '@server/enricher/index.ts';
import { LdapPool } from '@server/enricher/ldap-client.ts';
import { ldapConfigured, loadEnv } from '@server/env.ts';
import { buildApp } from '@server/http/app.ts';
import { createLogger } from '@server/logger.ts';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });

  logger.info({ env: env.NODE_ENV }, 'iniciando adminsearch');

  const db = createDb({ url: env.DATABASE_URL });
  await runMigrations(db.pool);
  logger.info('migrações aplicadas');

  let ldap: LdapPool | null = null;
  let enricher: Enricher | null = null;

  if (ldapConfigured(env)) {
    try {
      ldap = await LdapPool.create(
        {
          url: env.LDAP_URL as string,
          bindDn: env.LDAP_BIND_DN as string,
          bindPassword: env.LDAP_BIND_PASSWORD as string,
          baseDn: env.LDAP_BASE_DN as string,
          tlsCaFile: env.LDAP_TLS_CA_FILE,
        },
        logger,
      );
      enricher = new Enricher({
        db,
        ldap,
        logger,
        pollMs: env.ENRICHER_POLL_MS,
        cacheTtlMs: env.AD_USER_CACHE_TTL_HOURS * 3600_000,
      });
      enricher.start();
      logger.info('enricher LDAP iniciado');
    } catch (err) {
      logger.error({ err }, 'falha ao iniciar LDAP — enricher desabilitado');
      ldap = null;
      enricher = null;
    }
  } else {
    logger.warn('LDAP não configurado — enricher desabilitado, scans ficarão pendentes');
  }

  const app = await buildApp({
    db,
    ldap,
    logger,
    jwtSecret: env.JWT_SECRET,
    ingestToken: env.INGEST_TOKEN,
    staleAgentDays: env.STALE_AGENT_DAYS,
    cookieSecure: env.COOKIE_SECURE,
    cookieDomain: env.COOKIE_DOMAIN,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown solicitado');
    try {
      enricher?.stop();
      await app.close();
      await ldap?.dispose();
      await db.pool.end();
      logger.info('shutdown concluído');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'erro durante shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ url: `http://${env.HOST}:${env.PORT}` }, 'servidor pronto');
}

void main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: erro de boot
  console.error('Boot failed', err);
  process.exit(1);
});
