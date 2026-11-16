import pino, { type Logger } from 'pino';

/**
 * Creates the application root logger and a quieter child logger for Baileys internals.
 */
export function createAppLogger(level: string): {
  appLogger: Logger;
  baileysLogger: Logger;
} {
  const appLogger = pino({
    level,
    base: { service: 'aigis-bot' },
  });

  // Keep Baileys internal socket noise at warn/error unless debugging is explicitly requested.
  const baileysLevel = level === 'trace' || level === 'debug' ? level : 'warn';
  const baileysLogger = appLogger.child({ module: 'baileys' }, { level: baileysLevel });

  return { appLogger, baileysLogger };
}
