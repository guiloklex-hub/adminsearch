import { AdDirectorySyncRunner } from '@server/ad-sync/runner.ts';
import { type SchedulerHandle, startAdDirectoryScheduler } from '@server/ad-sync/scheduler.ts';
import { createDb } from '@server/db/client.ts';
import { runMigrations } from '@server/db/migrate.ts';
import { Enricher } from '@server/enricher/index.ts';
import { initInstitutionalGroupsCache } from '@server/enricher/institutional-groups-cache.ts';
import { LdapPool } from '@server/enricher/ldap-client.ts';
import { initSeverityPolicyCache } from '@server/enricher/severity-policy-cache.ts';
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

  const policyCache = initSeverityPolicyCache(db);
  await policyCache.ensureLoaded();
  logger.info('cache de política de severidade carregado');

  const institutionalCache = initInstitutionalGroupsCache(db);
  await institutionalCache.ensureLoaded();
  logger.info('cache de grupos institucionais carregado');

  let ldap: LdapPool | null = null;
  let enricher: Enricher | null = null;
  let adDirectoryRunner: AdDirectorySyncRunner | null = null;
  let adDirectoryScheduler: SchedulerHandle | null = null;

  if (ldapConfigured(env)) {
    try {
      ldap = await LdapPool.create(
        {
          url: env.LDAP_URL as string,
          bindDn: env.LDAP_BIND_DN as string,
          bindPassword: env.LDAP_BIND_PASSWORD as string,
          baseDn: env.LDAP_BASE_DN as string,
          tlsCaFile: env.LDAP_TLS_CA_FILE,
          tlsInsecure: env.LDAP_TLS_INSECURE,
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

      adDirectoryRunner = new AdDirectorySyncRunner({
        db,
        ldap,
        logger,
        pageSize: env.AD_DIRECTORY_LDAP_PAGE_SIZE,
      });
      if (env.AD_DIRECTORY_SYNC_ENABLED) {
        adDirectoryScheduler = startAdDirectoryScheduler({
          runner: adDirectoryRunner,
          logger,
          intervalMs: env.AD_DIRECTORY_SYNC_INTERVAL_HOURS * 3600_000,
          runOnBoot: env.AD_DIRECTORY_RUN_ON_BOOT,
        });
      } else {
        logger.warn('AD_DIRECTORY_SYNC_ENABLED=false — scheduler de diretório AD desabilitado');
      }
    } catch (err) {
      logger.error({ err }, 'falha ao iniciar LDAP — enricher desabilitado');
      ldap = null;
      enricher = null;
      adDirectoryRunner = null;
    }
  } else {
    logger.warn('LDAP não configurado — enricher desabilitado, scans ficarão pendentes');
  }

  const app = await buildApp({
    db,
    ldap,
    adDirectoryRunner,
    logger,
    jwtSecret: env.JWT_SECRET,
    ingestToken: env.INGEST_TOKEN,
    staleAgentDays: env.STALE_AGENT_DAYS,
    remediationMaxPerDispatch: env.REMEDIATION_MAX_PER_DISPATCH,
    remediationPlanRatePerMin: env.REMEDIATION_PLAN_RATE_PER_MIN,
    cookieSecure: env.COOKIE_SECURE,
    cookieDomain: env.COOKIE_DOMAIN,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown solicitado');
    try {
      adDirectoryScheduler?.stop();
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
