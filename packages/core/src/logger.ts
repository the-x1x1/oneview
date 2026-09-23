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
  /**
   * Collapse a warning that repeats: after one is written, the same warning (category,
   * message, and the `providerId`, `host` and `code` fields) is only counted for this long,
   * then written once more as a summary carrying `repeated` (how many were not written),
   * `firstRepeatAt`, `lastRepeatAt` and the last one's fields. 0 (the default) writes
   * every record.
   *
   * On the operator's machine a day of `app.log` was 9,155 lines, and 7,200 of them were
   * three warnings saying the same thing every poll: six decayed satellites skipped, a
   * local receiver that is not installed, a cache served while adsb.lol was throttling.
   * The file rotates at 5 MB, so that repetition was pushing out what the log is for, and
   * the diagnostics export's last 2,000 records were mostly the same three lines.
   */
  repeatWindowMs?: number;
}

interface Repeat {
  until: number;
  count: number;
  firstAt: number;
  lastAt: number;
  last: LogRecord;
}

/** Distinct repeating warnings tracked at once; past this, new ones are written in full. */
const MAX_REPEAT_KEYS = 512;

export class LoggerHub {
  private level: LogLevel;
  private readonly sinks: LogSink[];
  private readonly now: () => number;
  private readonly repeatWindowMs: number;
  private readonly repeats = new Map<string, Repeat>();
  private nextRepeatDue = Number.POSITIVE_INFINITY;

  constructor(opts: LoggerHubOptions = {}) {
    this.level = opts.level ?? 'info';
    this.sinks = [...(opts.sinks ?? [])];
    this.now = opts.now ?? Date.now;
    this.repeatWindowMs = Math.max(0, opts.repeatWindowMs ?? 0);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  emit(level: LogLevel, category: LogCategory, message: string, fields?: Record<string, JsonValue>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const now = this.now();
    if (now >= this.nextRepeatDue) this.drainRepeats(now, false);
    const record: LogRecord = { ts: new Date(now).toISOString(), level, category, message: redactText(message) };
    if (fields) record.fields = redactFields(fields);
    if (level === 'warn' && this.repeatWindowMs > 0) {
      const key = repeatKey(record);
      const seen = this.repeats.get(key);
      if (seen) {
        if (seen.count === 0) seen.firstAt = now;
        seen.count++;
        seen.lastAt = now;
        seen.last = record;
        return;
      }
      if (this.repeats.size < MAX_REPEAT_KEYS) {
        const until = now + this.repeatWindowMs;
        this.repeats.set(key, { until, count: 0, firstAt: now, lastAt: now, last: record });
        if (until < this.nextRepeatDue) this.nextRepeatDue = until;
      }
    }
    this.write(record);
  }

  async flush(): Promise<void> {
    this.drainRepeats(this.now(), true);
    await Promise.all(this.sinks.map((s) => s.flush?.()));
  }

  private write(record: LogRecord): void {
    for (const sink of this.sinks) {
      try {
        sink.write(record);
      } catch {
        /* a failing sink must never break the app */
      }
    }
  }

  /** Write the summary of every repeat window that has closed (or all of them), and forget it. */
  private drainRepeats(now: number, all: boolean): void {
    let next = Number.POSITIVE_INFINITY;
    for (const [key, r] of this.repeats) {
      if (!all && now < r.until) {
        if (r.until < next) next = r.until;
        continue;
      }
      this.repeats.delete(key);
      if (r.count === 0) continue;
      this.write({
        ts: new Date(now).toISOString(),
        level: r.last.level,
        category: r.last.category,
        message: r.last.message,
        fields: {
          ...r.last.fields,
          repeated: r.count,
          firstRepeatAt: new Date(r.firstAt).toISOString(),
          lastRepeatAt: new Date(r.lastAt).toISOString(),
        },
      });
    }
    this.nextRepeatDue = next;
  }

  logger(category: LogCategory, base: Record<string, JsonValue> = {}): Logger {
    const make = (bound: Record<string, JsonValue>): Logger => ({
      category,
      debug: (m, f) => this.emit('debug', category, m, { ...bound, ...f }),
      info: (m, f) => this.emit('info', category, m, { ...bound, ...f }),
      warn: (m, f) => this.emit('warn', category, m, { ...bound, ...f }),
      error: (m, f) => this.emit('error', category, m, { ...bound, ...f }),
      child: (f) => make({ ...bound, ...f }),
    });
    return make(base);
  }
}

/**
 * What makes two warnings "the same" for collapsing: the message and the fields that name
 * *what* it is about — the provider, host and error code, and the part of a provider it
 * concerns (a camera pack, a CelesTrak group, a layer). Without the last, Hong Kong's
 * rejected rows were collapsed as a repeat of New South Wales's, a second earlier, and
 * never written. Counts, samples and free-text details are not part of it.
 */
const REPEAT_KEY_FIELDS = ['providerId', 'host', 'code', 'pack', 'group', 'layer', 'sourceId'] as const;

function repeatKey(r: LogRecord): string {
  const f = r.fields ?? {};
  const part = (k: string) => (typeof f[k] === 'string' || typeof f[k] === 'number' ? String(f[k]) : '');
  return [r.category, r.message, ...REPEAT_KEY_FIELDS.map(part)].join('\u0000');
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
