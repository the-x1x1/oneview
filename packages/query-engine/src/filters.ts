import type { JsonValue, WorldFilter } from '@worldview/world-model';
import { compareValues, comparableKind, toNumber, type FieldValue } from './fields.js';

/**
 * WorldFilter evaluation. Pure. Semantics:
 *
 *   eq / neq      type-aware equality (numbers numerically, numeric strings coerced;
 *                 strings exact, case-sensitive)
 *   gt/gte/lt/lte type-aware ordering; a missing field never satisfies an ordering test
 *   in            `value` is an array; membership by `eq` rules
 *   contains      string field → case-insensitive substring; array field → element `eq`;
 *                 object field → key present
 *   exists        `value` false/"false" → field must be absent; otherwise must be present
 */
export function matchesFilter(field: FieldValue, filter: WorldFilter): boolean {
  const v = filter.value;
  switch (filter.op) {
    case 'exists': {
      const wantPresent = !(v === false || v === 'false' || v === 0);
      const present = field !== undefined && field !== null;
      return wantPresent ? present : !present;
    }
    case 'eq': return field !== undefined && equals(field, v);
    case 'neq': return !(field !== undefined && equals(field, v));
    case 'gt': return ordered(field, v) > 0;
    case 'gte': return ordered(field, v) >= 0;
    case 'lt': return ordered(field, v) < 0;
    case 'lte': return ordered(field, v) <= 0;
    case 'in': {
      if (!Array.isArray(v)) return field !== undefined && equals(field, v);
      return field !== undefined && v.some((x) => equals(field, x));
    }
    case 'contains': {
      if (field === undefined || field === null) return false;
      if (typeof field === 'string') return typeof v === 'string' ? field.toLowerCase().includes(v.toLowerCase()) : v !== undefined && field.toLowerCase().includes(String(v).toLowerCase());
      if (Array.isArray(field)) return field.some((x) => equals(x, v));
      if (typeof field === 'object') return typeof v === 'string' && Object.prototype.hasOwnProperty.call(field, v);
      return equals(field, v);
    }
  }
}

export function matchesAll(resolve: (path: string) => FieldValue, filters: readonly WorldFilter[] | undefined): boolean {
  if (!filters || filters.length === 0) return true;
  for (const f of filters) if (!matchesFilter(resolve(f.field), f)) return false;
  return true;
}

function equals(a: JsonValue, b: JsonValue | undefined): boolean {
  if (b === undefined) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' || typeof b === 'number') {
    const na = typeof a === 'number' ? a : Number(a), nb = typeof b === 'number' ? b : Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && (typeof a !== 'string' || a.trim() !== '') && (typeof b !== 'string' || b.trim() !== '')) return na === nb;
    return false;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b || String(a) === String(b);
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Ordering with a NaN sentinel for incomparable inputs (never satisfies gt/gte/lt/lte). */
function ordered(field: FieldValue, v: JsonValue | undefined): number {
  if (field === undefined || v === undefined) return Number.NaN;
  const kf = comparableKind(field), kv = comparableKind(v);
  if (kf === 'none' || kv === 'none' || kf === 'other' || kv === 'other') return Number.NaN;
  if (kf !== kv) {
    // Only numeric strings vs numbers are comparable across kinds.
    const nf = toNumber(field), nv = toNumber(v);
    return nf !== undefined && nv !== undefined ? nf - nv : Number.NaN;
  }
  return compareValues(field, v);
}
