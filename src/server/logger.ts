import pino, { type Logger, type LoggerOptions } from 'pino';

export type AppLogger = Logger;

export function createLogger(opts: { level: string; pretty: boolean }): AppLogger {
  const base: LoggerOptions = {
    level: opts.level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.passwordHash',
        '*.ingestToken',
        '*.jwtSecret',
        '*.bindPassword',
      ],
      censor: '[REDACTED]',
    },
  };

  if (opts.pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino(base);
}
