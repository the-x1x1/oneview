import type { JsonValue } from '@worldview/world-model';

/**
 * Structured logging. Categories are fixed (directive §85). Every sink receives
 * already-redacted records; redaction happens once, centrally.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory =
  | 'app'
  | 'provider'
  | 'world-state'
  | 'renderer'
  | 'history'
  | 'offline'
  | 'camera'
  | 'security'
  | 'updater'
  | 'ipc'
  | 'diagnostics';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  fields?: Record<string, JsonValue>;
}

export interface LogSink {
  write(record: LogRecord): void;
  flush?(): Promise<void>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /(key|token|secret|password|passwd|pwd|authorization|credential|cookie|session)/i;
const SECRET_IN_TEXT = [
  /([?&](?:key|api_key|apikey|token|access_token|map_key|mapkey|password|pwd|secret)=)[^&\s"']+/gi,
  /(bearer\s+)[a-z0-9._~+/=-]+/gi,
  /(https?:\/\/)[^\s/@"']+:[^\s/@"']+@/gi,
  /(rtsps?:\/\/)[^\s/@"']+:[^\s/@"']+@/gi,
];

export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_IN_TEXT) out = out.replace(re, (_m, prefix: string) => `${prefix}<redacted>`);
  return out;
}

export function redactFields(fields: Record<string, JsonValue>, depth = 0): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) {
      out[k] = '<redacted>';
      continue;
    }
    out[k] = redactValue(v, depth + 1);
  }
  return out;
}

function redactValue(v: JsonValue, depth: number): JsonValue {
  if (depth > 8) return '<truncated>';
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => redactValue(x, depth + 1));
  if (v && typeof v === 'object') return redactFields(v, depth);
  return v;
}

export interface Logger {
  readonly category: LogCategory;
  debug(message: string, fields?: Record<string, JsonValue>): void;
  info(message: string, fields?: Record<string, JsonValue>): void;
  warn(message: string, fields?: Record<string, JsonValue>): void;
  error(message: string, fields?: Record<string, JsonValue>): void;
  child(fields: Record<string, JsonValue>): Logger;
}

export interface LoggerHubOptions {
  level?: LogLevel;
  sinks?: LogSink[];
  now?: () => number;
}

export class LoggerHub {
  private level: LogLevel;
  private readonly sinks: LogSink[];
  private readonly now: () => number;

  constructor(opts: LoggerHubOptions = {}) {
    this.level = opts.level ?? 'info';
    this.sinks = [...(opts.sinks ?? [])];
    this.now = opts.now ?? Date.now;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  emit(level: LogLevel, category: LogCategory, message: string, fields?: Record<string, JsonValue>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record: LogRecord = { ts: new Date(this.now()).toISOString(), level, category, message: redactText(message) };
    if (fields) record.fields = redactFields(fields);
    for (const sink of this.sinks) {
      try {
        sink.write(record);
      } catch {
        /* a failing sink must never break the app */
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.flush?.()));
  }

  logger(category: LogCategory, base: Record<string, JsonValue> = {}): Logger {
    const hub = this;
    const make = (bound: Record<string, JsonValue>): Logger => ({
      category,
      debug: (m, f) => hub.emit('debug', category, m, { ...bound, ...f }),
      info: (m, f) => hub.emit('info', category, m, { ...bound, ...f }),
      warn: (m, f) => hub.emit('warn', category, m, { ...bound, ...f }),
      error: (m, f) => hub.emit('error', category, m, { ...bound, ...f }),
      child: (f) => make({ ...bound, ...f }),
    });
    return make(base);
  }
}

/** In-memory ring buffer sink (diagnostics export, tests). */
export class RingBufferSink implements LogSink {
  readonly records: LogRecord[] = [];
  constructor(private readonly capacity = 2000) {}
  write(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
  }
}

export class ConsoleSink implements LogSink {
  write(r: LogRecord): void {
    const line = `${r.ts} ${r.level.toUpperCase().padEnd(5)} [${r.category}] ${r.message}${r.fields ? ' ' + JSON.stringify(r.fields) : ''}`;
    if (r.level === 'error') console.error(line);
    else if (r.level === 'warn') console.warn(line);
    else console.log(line);
  }
}

export const silentLogger: Logger = {
  category: 'app',
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
