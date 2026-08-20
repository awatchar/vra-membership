/**
 * Structured logger with a strict allowlist.
 *
 * Privacy contract (see docs/security-privacy.md):
 * only technical metadata may be logged. Personal data, provider payloads,
 * form bodies, images, OCR results and secrets must never reach the log sink.
 * The allowlist below is the enforcement point: unknown keys are dropped.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Keys that are safe to log. Extend deliberately, never with PII. */
const ALLOWED_FIELDS = [
  'requestId',
  'event',
  'method',
  'path',
  'route',
  'status',
  'durationMs',
  'environment',
  'applicationId',
  'errorCode',
  'provider',
  'providerStatus',
  'attempt',
  'count',
  'reason',
] as const;

export type LogField = (typeof ALLOWED_FIELDS)[number];

/** Only primitives are accepted; objects could smuggle nested personal data. */
export type LogFields = Partial<Record<LogField, string | number | boolean>>;

const ALLOWED_FIELD_SET: ReadonlySet<string> = new Set(ALLOWED_FIELDS);

function sanitize(fields: LogFields): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELD_SET.has(key)) continue;
    if (value === undefined || value === null) continue;
    const type = typeof value;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') continue;
    output[key] = value;
  }
  return output;
}

export interface Logger {
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
  /** Returns a logger that merges `base` into every entry. */
  with(base: LogFields): Logger;
}

export interface LoggerOptions {
  /** Entries below this level are dropped. */
  level?: LogLevel;
  sink?: (level: LogLevel, entry: Record<string, unknown>) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function defaultSink(level: LogLevel, entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minimum = LEVEL_ORDER[options.level ?? 'info'];
  const sink = options.sink ?? defaultSink;

  const build = (base: LogFields): Logger => {
    const emit = (level: LogLevel, fields: LogFields): void => {
      if (LEVEL_ORDER[level] < minimum) return;
      sink(level, { level, ...sanitize({ ...base, ...fields }) });
    };
    return {
      debug: (fields) => emit('debug', fields),
      info: (fields) => emit('info', fields),
      warn: (fields) => emit('warn', fields),
      error: (fields) => emit('error', fields),
      with: (extra) => build({ ...base, ...extra }),
    };
  };

  return build({});
}
