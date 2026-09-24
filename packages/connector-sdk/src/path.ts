import type { JsonValue } from '@worldview/world-model';

/**
 * Field paths into a JSON record — the only way a mapping reaches into a source's data.
 *
 *   `properties.mag`      keys separated by dots
 *   `geometry.coordinates[1]`  an array index; `[-1]` is the last element
 *   `["a.b"].c`           a key containing a dot or bracket, quoted
 *   `$`                   the record itself
 *
 * That is the whole grammar. No wildcards, no filters, no expressions: a path names one
 * value or nothing, and reading it can neither run code nor reach outside the record.
 */
export type PathSegment = { key: string } | { index: number };

export const MAX_PATH_LENGTH = 256;
export const MAX_PATH_DEPTH = 32;

const cache = new Map<string, PathSegment[] | Error>();

export function parsePath(path: string): PathSegment[] {
  const hit = cache.get(path);
  if (hit) {
    if (hit instanceof Error) throw hit;
    return hit;
  }
  let result: PathSegment[] | Error;
  try {
    result = parse(path);
  } catch (err) {
    result = err instanceof Error ? err : new Error(String(err));
  }
  if (cache.size > 4096) cache.clear();
  cache.set(path, result);
  if (result instanceof Error) throw result;
  return result;
}

function parse(path: string): PathSegment[] {
  if (typeof path !== 'string') throw new Error('path must be a string');
  if (path.length === 0) throw new Error('path is empty');
  if (path.length > MAX_PATH_LENGTH) throw new Error(`path longer than ${MAX_PATH_LENGTH} characters`);
  if (path === '$') return [];
  const out: PathSegment[] = [];
  let i = 0;
  if (path.startsWith('$.')) i = 2;
  else if (path.startsWith('$[')) i = 1;
  let expectKey = true;
  while (i < path.length) {
    const c = path[i]!;
    if (c === '[') {
      const close = path.indexOf(']', i);
      if (close < 0) throw new Error(`unclosed [ in path "${path}"`);
      const inner = path.slice(i + 1, close);
      if (/^-?\d+$/.test(inner)) out.push({ index: Number(inner) });
      else if (/^"([^"\\]|\\.)*"$/.test(inner)) out.push({ key: inner.slice(1, -1).replace(/\\(.)/g, '$1') });
      else throw new Error(`bad index "${inner}" in path "${path}"`);
      i = close + 1;
      expectKey = false;
      continue;
    }
    if (c === '.') {
      if (expectKey) throw new Error(`empty key in path "${path}"`);
      i++;
      expectKey = true;
      continue;
    }
    if (!expectKey) throw new Error(`expected . or [ at ${i} in path "${path}"`);
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    out.push({ key: path.slice(i, j) });
    i = j;
    expectKey = false;
  }
  if (expectKey) throw new Error(`path "${path}" ends with .`);
  if (out.length > MAX_PATH_DEPTH) throw new Error(`path deeper than ${MAX_PATH_DEPTH}`);
  return out;
}

/** The value at `path` in `record`, or undefined when any step is missing. Never throws on data. */
export function readPath(record: unknown, path: string | PathSegment[]): JsonValue | undefined {
  const segments = typeof path === 'string' ? parsePath(path) : path;
  let cur: unknown = record;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if ('index' in seg) {
      if (!Array.isArray(cur)) return undefined;
      const i = seg.index < 0 ? cur.length + seg.index : seg.index;
      cur = cur[i];
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, seg.key)) return undefined;
      cur = (cur as Record<string, unknown>)[seg.key];
    }
  }
  return cur === undefined ? undefined : (cur as JsonValue);
}

export function formatPath(segments: PathSegment[]): string {
  if (segments.length === 0) return '$';
  let out = '';
  for (const seg of segments) {
    if ('index' in seg) out += `[${seg.index}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(seg.key)) out += (out ? '.' : '') + seg.key;
    else out += `["${seg.key.replace(/(["\\])/g, '\\$1')}"]`;
  }
  return out;
}
