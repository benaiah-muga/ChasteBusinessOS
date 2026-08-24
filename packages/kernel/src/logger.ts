/**
 * Structured JSON logging with zero dependencies. One line per event so any
 * log shipper can parse it; level filtered by LOG_LEVEL. Fields win over
 * prose: pass ids (orgId, sessionId, capabilityId) as fields, keep msg short.
 *
 * A vendor logger (pino) can replace this behind the same call sites once
 * the project needs transports/rotation; until then, no dependency bloat.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;

export interface LogFields {
  [key: string]: unknown;
}

function emit(level: LogLevel, msg: string, fields: LogFields): void {
  if (LEVELS[level] < configured) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger with fields merged into every subsequent call. */
  child(bound: LogFields): Logger;
}

export function createLogger(bound: LogFields = {}): Logger {
  return {
    debug: (msg, fields) => emit("debug", msg, { ...bound, ...fields }),
    info: (msg, fields) => emit("info", msg, { ...bound, ...fields }),
    warn: (msg, fields) => emit("warn", msg, { ...bound, ...fields }),
    error: (msg, fields) => emit("error", msg, { ...bound, ...fields }),
    child: (extra) => createLogger({ ...bound, ...extra }),
  };
}

export const logger = createLogger();
