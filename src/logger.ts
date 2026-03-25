import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Optional DB error logger - set by db.ts after initialization
// Avoids circular dependency between logger.ts and db.ts
let dbErrorLogger: ((level: string, message: string, context?: Record<string, unknown>) => void) | null = null;

export function setDbErrorLogger(fn: typeof dbErrorLogger): void {
  dbErrorLogger = fn;
}

// Wrapped loggers that also write to error_log table
export const log = {
  error: (context: Record<string, unknown>, message: string): void => {
    logger.error(context, message);
    dbErrorLogger?.('error', message, context);
  },
  fatal: (context: Record<string, unknown>, message: string): void => {
    logger.fatal(context, message);
    dbErrorLogger?.('fatal', message, context);
  },
};

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
