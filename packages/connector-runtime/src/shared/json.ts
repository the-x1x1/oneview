/**
 * A parsed JSON value that is an object with keys — not `null`, not an array. Every
 * connector that reads a service's JSON by hand (ArcGIS layer descriptions and esriJSON,
 * TopoJSON, Traccar's devices and positions, the MQTT suite's fixtures) checks this before it
 * indexes into a value, and each had written the same one-line guard.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A finite number from a JSON value that is a number or a numeric string (`"12.5"`, `" 3 "`);
 * undefined for anything else, a blank string and `NaN`/`Infinity` included. Services send
 * numbers as strings often enough (esriJSON extents, rtl_433 readings, operator settings)
 * that every reader accepts both.
 */
export function finiteNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}
