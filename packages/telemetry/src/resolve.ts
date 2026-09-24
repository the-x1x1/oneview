import type { JsonValue } from '@worldview/world-model';
import type { TelemetryDescriptor, TelemetrySeries } from '@worldview/provider-sdk';
import { DEFAULT_READINGS, DISCOVERED_TYPES, KNOWN_READINGS } from './known.js';

/** Same cap and key shape as the descriptor schema (`provider-sdk/telemetry.ts`). */
export const MAX_SERIES = 32;
const SERIES_KEY = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
/** Numbers that are not readings: coordinates and identifiers. */
const NOT_A_READING = new Set(['latitude', 'longitude', 'lat', 'lon', 'lng']);
const IDENTIFIER = /(?:^id|Id|ID|_id)$/;

/** Where a resolved descriptor came from, for the panel's footnote and for tests. */
export type TelemetryOrigin = 'source' | 'default' | 'discovered';

export interface ResolvedTelemetry {
  series: TelemetrySeries[];
  origin: TelemetryOrigin;
}

export interface TelemetryInput {
  objectType: string;
  /** The object's current payload (`WorldObject.properties`). */
  properties: Readonly<Record<string, JsonValue>>;
  /**
   * The descriptors of the providers the object came from, in its `sourceRefs` order
   * (`ProviderManifest.telemetry`, a definition's `telemetry` block). Absent entries are skipped.
   */
  sourceDescriptors?: ReadonlyArray<TelemetryDescriptor | undefined>;
}

/** True when the payload carries `key` as a finite number. */
export function hasReading(properties: Readonly<Record<string, JsonValue>>, key: string): boolean {
  const v = properties[key];
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The readings to plot for one object, or undefined when it has none.
 *
 * 1. Its sources' descriptors: every series whose key the object carries, first provider
 *    first, one series per key.
 * 2. Its type's default table (`DEFAULT_READINGS`), each entry's first key present.
 * 3. For a sensor (or a weather station whose defaults all missed): every numeric payload
 *    key, named from `KNOWN_READINGS` when the key is a known one and by the key otherwise.
 *
 * Only keys the current payload carries are offered, so a descriptor written for a
 * provider's several kinds of record shows each object only what it has. Capped at 32.
 */
export function resolveTelemetry(input: TelemetryInput): ResolvedTelemetry | undefined {
  const { properties } = input;
  const fromSources: TelemetrySeries[] = [];
  const seen = new Set<string>();
  for (const d of input.sourceDescriptors ?? []) {
    for (const series of d?.series ?? []) {
      if (seen.has(series.key) || !hasReading(properties, series.key)) continue;
      seen.add(series.key);
      fromSources.push(series);
    }
  }
  if (fromSources.length) return { series: fromSources.slice(0, MAX_SERIES), origin: 'source' };

  const defaults = DEFAULT_READINGS[input.objectType];
  if (defaults) {
    const series: TelemetrySeries[] = [];
    for (const alternatives of defaults) {
      const key = alternatives.find((k) => hasReading(properties, k));
      if (key) series.push(knownSeries(key));
    }
    if (series.length) return { series, origin: 'default' };
  }

  if (DISCOVERED_TYPES.has(input.objectType)) {
    const series = discoverReadings(properties);
    if (series.length) return { series, origin: 'discovered' };
  }
  return undefined;
}

/** Every numeric payload key that could be a reading, in payload order, capped at 32. */
export function discoverReadings(properties: Readonly<Record<string, JsonValue>>): TelemetrySeries[] {
  const out: TelemetrySeries[] = [];
  for (const key of Object.keys(properties)) {
    if (out.length >= MAX_SERIES) break;
    if (!hasReading(properties, key) || !SERIES_KEY.test(key)) continue;
    if (NOT_A_READING.has(key) || IDENTIFIER.test(key)) continue;
    out.push(knownSeries(key));
  }
  return out;
}

/** The known name, units and format for a key, or the key itself as the name. */
export function knownSeries(key: string): TelemetrySeries {
  const known = KNOWN_READINGS[key];
  return known ? { key, ...known } : { key, name: key };
}
