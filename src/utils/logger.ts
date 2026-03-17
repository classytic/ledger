/**
 * Minimal logger interface for the accounting package.
 * Defaults to console. App layer can inject a real logger (Winston/Pino).
 */
export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
}

/** Default console-based implementation */
export const defaultLogger: Logger = {
  warn: (msg, meta) => console.warn(`[accounting] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[accounting] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[accounting] ${msg}`, meta ?? ''),
};
