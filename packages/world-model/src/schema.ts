/**
 * Minimal, dependency-free runtime schema combinators.
 *
 * Used to validate everything that crosses a trust boundary: provider manifests,
 * normalized observations, worldpack manifests, IPC payloads, settings, imported
 * collections. Deliberately small; not a general-purpose validation framework.
 */
export interface SchemaIssue {
  path: string;
  message: string;
}

export type SchemaResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

export interface Schema<T> {
  readonly kind: string;
  parse(value: unknown, path?: string): SchemaResult<T>;
  /** Static type carrier (never assigned). */
  readonly _type?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const fail = (path: string, message: string): SchemaResult<never> => ({ ok: false, issues: [{ path, message }] });
const ok = <T>(value: T): SchemaResult<T> => ({ ok: true, value });
const join = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));

function make<T>(kind: string, parse: (value: unknown, path: string) => SchemaResult<T>): Schema<T> {
  return { kind, parse: (value, path = '') => parse(value, path) };
}

export const s = {
  string(opts: { min?: number; max?: number; pattern?: RegExp } = {}): Schema<string> {
    return make('string', (v, p) => {
      if (typeof v !== 'string') return fail(p, 'expected string');
      if (opts.min !== undefined && v.length < opts.min) return fail(p, `expected at least ${opts.min} characters`);
      if (opts.max !== undefined && v.length > opts.max) return fail(p, `expected at most ${opts.max} characters`);
      if (opts.pattern && !opts.pattern.test(v)) return fail(p, `does not match ${opts.pattern}`);
      return ok(v);
    });
  },
  number(opts: { min?: number; max?: number; integer?: boolean } = {}): Schema<number> {
    return make('number', (v, p) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail(p, 'expected finite number');
      if (opts.integer && !Number.isInteger(v)) return fail(p, 'expected integer');
      if (opts.min !== undefined && v < opts.min) return fail(p, `expected >= ${opts.min}`);
      if (opts.max !== undefined && v > opts.max) return fail(p, `expected <= ${opts.max}`);
      return ok(v);
    });
  },
  boolean(): Schema<boolean> {
    return make('boolean', (v, p) => (typeof v === 'boolean' ? ok(v) : fail(p, 'expected boolean')));
  },
  literal<const L extends string | number | boolean | null>(lit: L): Schema<L> {
    return make('literal', (v, p) => (v === lit ? ok(lit) : fail(p, `expected ${JSON.stringify(lit)}`)));
  },
  enum<const E extends readonly (string | number | boolean | null)[]>(values: E): Schema<E[number]> {
    const set = new Set<unknown>(values);
    return make('enum', (v, p) => (set.has(v) ? ok(v as E[number]) : fail(p, `expected one of ${values.map((x) => JSON.stringify(x)).join(', ')}`)));
  },
  optional<T>(inner: Schema<T>): Schema<T | undefined> {
    return make('optional', (v, p) => (v === undefined ? ok(undefined) : inner.parse(v, p)));
  },
  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return make('nullable', (v, p) => (v === null ? ok(null) : inner.parse(v, p)));
  },
  array<T>(inner: Schema<T>, opts: { min?: number; max?: number } = {}): Schema<T[]> {
    return make('array', (v, p) => {
      if (!Array.isArray(v)) return fail(p, 'expected array');
      if (opts.min !== undefined && v.length < opts.min) return fail(p, `expected at least ${opts.min} items`);
      if (opts.max !== undefined && v.length > opts.max) return fail(p, `expected at most ${opts.max} items`);
      const out: T[] = [];
      const issues: SchemaIssue[] = [];
      v.forEach((item, i) => {
        const r = inner.parse(item, join(p, i));
        if (r.ok) out.push(r.value);
        else issues.push(...r.issues);
      });
      return issues.length ? { ok: false, issues } : ok(out);
    });
  },
  tuple<const T extends readonly Schema<unknown>[]>(items: T): Schema<{ [K in keyof T]: Infer<T[K]> }> {
    return make('tuple', (v, p) => {
      if (!Array.isArray(v) || v.length !== items.length) return fail(p, `expected tuple of ${items.length}`);
      const out: unknown[] = [];
      const issues: SchemaIssue[] = [];
      items.forEach((sch, i) => {
        const r = sch.parse(v[i], join(p, i));
        if (r.ok) out.push(r.value);
        else issues.push(...r.issues);
      });
      return issues.length ? { ok: false, issues } : ok(out as { [K in keyof T]: Infer<T[K]> });
    });
  },
  object<Shape extends Record<string, Schema<unknown>>>(
    shape: Shape,
    opts: { strict?: boolean } = {},
  ): Schema<{ [K in keyof Shape as undefined extends Infer<Shape[K]> ? never : K]: Infer<Shape[K]> } & { [K in keyof Shape as undefined extends Infer<Shape[K]> ? K : never]?: Exclude<Infer<Shape[K]>, undefined> }> {
    return make('object', (v, p) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, 'expected object');
      const input = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const issues: SchemaIssue[] = [];
      for (const key of Object.keys(shape)) {
        const r = shape[key]!.parse(input[key], join(p, key));
        if (r.ok) {
          if (r.value !== undefined) out[key] = r.value;
        } else issues.push(...r.issues);
      }
      if (opts.strict) {
        for (const key of Object.keys(input)) if (!(key in shape)) issues.push({ path: join(p, key), message: 'unexpected key' });
      }
      return issues.length ? { ok: false, issues } : ok(out as never);
    });
  },
  record<T>(inner: Schema<T>, opts: { keyPattern?: RegExp; max?: number } = {}): Schema<Record<string, T>> {
    return make('record', (v, p) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, 'expected object');
      const entries = Object.entries(v as Record<string, unknown>);
      if (opts.max !== undefined && entries.length > opts.max) return fail(p, `expected at most ${opts.max} keys`);
      const out: Record<string, T> = {};
      const issues: SchemaIssue[] = [];
      for (const [k, val] of entries) {
        if (opts.keyPattern && !opts.keyPattern.test(k)) { issues.push({ path: join(p, k), message: 'invalid key' }); continue; }
        const r = inner.parse(val, join(p, k));
        if (r.ok) out[k] = r.value;
        else issues.push(...r.issues);
      }
      return issues.length ? { ok: false, issues } : ok(out);
    });
  },
  union<const T extends readonly Schema<unknown>[]>(options: T): Schema<Infer<T[number]>> {
    return make('union', (v, p) => {
      const all: SchemaIssue[] = [];
      for (const o of options) {
        const r = o.parse(v, p);
        if (r.ok) return ok(r.value as Infer<T[number]>);
        all.push(...r.issues);
      }
      return { ok: false, issues: [{ path: p, message: `no union member matched (${all.map((i) => i.message).slice(0, 3).join('; ')})` }] };
    });
  },
  /** Any JSON value (validated to be JSON-representable, bounded depth). */
  json(opts: { maxDepth?: number } = {}): Schema<import('./json.js').JsonValue> {
    const maxDepth = opts.maxDepth ?? 32;
    const check = (v: unknown, depth: number, p: string): SchemaIssue | undefined => {
      if (depth > maxDepth) return { path: p, message: 'json too deep' };
      if (v === null) return undefined;
      switch (typeof v) {
        case 'string': case 'boolean': return undefined;
        case 'number': return Number.isFinite(v) ? undefined : { path: p, message: 'non-finite number' };
        case 'object': {
          if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const e = check(v[i], depth + 1, join(p, i)); if (e) return e; } return undefined; }
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) { if (val === undefined) continue; const e = check(val, depth + 1, join(p, k)); if (e) return e; }
          return undefined;
        }
        default: return { path: p, message: `non-json value (${typeof v})` };
      }
    };
    return make('json', (v, p) => {
      const issue = check(v, 0, p);
      return issue ? { ok: false, issues: [issue] } : ok(v as import('./json.js').JsonValue);
    });
  },
  refine<T>(inner: Schema<T>, predicate: (value: T) => string | undefined): Schema<T> {
    return make(`refined(${inner.kind})`, (v, p) => {
      const r = inner.parse(v, p);
      if (!r.ok) return r;
      const msg = predicate(r.value);
      return msg ? fail(p, msg) : r;
    });
  },
  lazy<T>(factory: () => Schema<T>): Schema<T> {
    let cached: Schema<T> | undefined;
    return make('lazy', (v, p) => (cached ??= factory()).parse(v, p));
  },
};

export function formatIssues(issues: SchemaIssue[], limit = 8): string {
  return issues.slice(0, limit).map((i) => `${i.path || '<root>'}: ${i.message}`).join('; ') + (issues.length > limit ? ` (+${issues.length - limit} more)` : '');
}

/** Throwing convenience for trusted internal call sites. */
export function assertSchema<T>(schema: Schema<T>, value: unknown, label = 'value'): T {
  const r = schema.parse(value);
  if (!r.ok) throw new Error(`invalid ${label}: ${formatIssues(r.issues)}`);
  return r.value;
}
