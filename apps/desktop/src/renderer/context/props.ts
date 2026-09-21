import type { JsonValue, WorldObject } from '@worldview/world-model';

/** Typed readers over `WorldObject.properties`; undefined when absent or of the wrong type. */
export function num(o: WorldObject, key: string): number | undefined {
  const v = o.properties[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function str(o: WorldObject, key: string): string | undefined {
  const v = o.properties[key];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function bool(o: WorldObject, key: string): boolean | undefined {
  const v = o.properties[key];
  return typeof v === 'boolean' ? v : undefined;
}

export function yesNo(v: boolean | undefined): string | undefined {
  return v === undefined ? undefined : v ? 'Yes' : 'No';
}

export function strList(o: WorldObject, key: string): string[] | undefined {
  const v: JsonValue | undefined = o.properties[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/** Best display name for an object: callsign, name, title, registration, place, then id value. */
export function displayName(o: WorldObject): string {
  return o.labels['callsign'] ?? o.labels['name'] ?? o.labels['title'] ?? o.labels['registration'] ?? o.labels['place'] ?? o.id.split(':').slice(2).join(':') ?? o.id;
}

/** Only https links to known hosts are surfaced as clickable (renderer never opens arbitrary schemes). */
export function safeHttpsUrl(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try { const u = new URL(v); return u.protocol === 'https:' ? u.toString() : undefined; } catch { return undefined; }
}
