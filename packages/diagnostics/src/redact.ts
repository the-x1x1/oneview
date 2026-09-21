import os from 'node:os';
import type { JsonValue } from '@worldview/world-model';
import { redactFields, redactText } from '@worldview/core';

/**
 * Bundle redaction = core secret redaction (keys/tokens/URL credentials) plus
 * user-path redaction: the home directory and any other per-user root becomes `~`
 * so a shared bundle never reveals the account name.
 */
export interface PathRedactionOptions {
  /** Home directory of the current user (os.homedir() by default). */
  homeDir?: string;
  /** Additional roots to collapse (e.g. a custom --data-dir). */
  extraRoots?: string[];
}

const GENERIC_USER_ROOTS = [
  /[A-Za-z]:\\Users\\[^\\/\s"']+/g, // C:\Users\name
  /[A-Za-z]:\/Users\/[^\\/\s"']+/g, // C:/Users/name (forward-slash variant)
  /\/Users\/[^/\s"']+/g, // macOS
  /\/home\/[^/\s"']+/g, // Linux
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactPathsInText(text: string, opts: PathRedactionOptions = {}): string {
  let out = text;
  const roots = [opts.homeDir ?? os.homedir(), ...(opts.extraRoots ?? [])].filter((r) => r && r.length > 1);
  for (const root of roots) {
    const variants = new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')]);
    for (const v of variants) out = out.replace(new RegExp(escapeRegExp(v), 'g'), '~');
  }
  for (const re of GENERIC_USER_ROOTS) out = out.replace(re, '~');
  return out;
}

export function redactValueDeep(value: JsonValue, opts: PathRedactionOptions = {}): JsonValue {
  if (typeof value === 'string') return redactPathsInText(redactText(value), opts);
  if (Array.isArray(value)) return value.map((v) => redactValueDeep(v, opts));
  if (value && typeof value === 'object') {
    const redactedKeys = redactFields(value);
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(redactedKeys)) out[k] = redactValueDeep(v, opts);
    return out;
  }
  return value;
}

/** Redacts any JSON-serialisable structure (objects with undefined fields are dropped by JSON semantics). */
export function redactStructure<T>(value: T, opts: PathRedactionOptions = {}): T {
  return redactValueDeep(JSON.parse(JSON.stringify(value)) as JsonValue, opts) as unknown as T;
}
