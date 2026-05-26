import type { AppLogger } from '@server/logger.ts';
import type { AdDirectorySyncRunner } from './runner.ts';
import { SyncAlreadyRunningError } from './types.ts';

export interface SchedulerHandle {
  stop: () => void;
}

export interface SchedulerOptions {
  runner: AdDirectorySyncRunner;
  logger: AppLogger;
  intervalMs: number;
  bootDelayMs?: number;
  runOnBoot?: boolean;
}

/**
 * Agenda execuções periódicas do sync de diretório AD.
 *
 * - Tick inicial (opcional): `bootDelayMs` após a chamada (default 30s) com
 *   trigger `boot`. Deixa o app subir antes de saturar o LDAP.
 * - Recorrente: a cada `intervalMs` com trigger `scheduler`.
 *
 * Se um sync já estiver rodando (em qualquer processo), o `SyncAlreadyRunningError`
 * é silenciosamente ignorado — o próximo tick tentará de novo.
 */
export function startAdDirectoryScheduler(opts: SchedulerOptions): SchedulerHandle {
  const { runner, logger, intervalMs, bootDelayMs = 30_000, runOnBoot = true } = opts;

  const tick = (source: 'boot' | 'scheduler'): void => {
    void runner.runOnce(source).catch((err) => {
      if (err instanceof SyncAlreadyRunningError) {
        logger.debug({ source }, 'ad-sync scheduler: pulando tick — já há sync em execução');
        return;
      }
      logger.error({ err, source }, 'ad-sync scheduler: erro no tick');
    });
  };

  let bootTimer: NodeJS.Timeout | null = null;
  if (runOnBoot) {
    bootTimer = setTimeout(() => tick('boot'), bootDelayMs);
  }
  const intervalTimer = setInterval(() => tick('scheduler'), intervalMs);

  logger.info({ intervalMs, runOnBoot, bootDelayMs }, 'ad-sync scheduler iniciado');

  return {
    stop: () => {
      if (bootTimer) clearTimeout(bootTimer);
      clearInterval(intervalTimer);
      logger.info('ad-sync scheduler parado');
    },
  };
}
