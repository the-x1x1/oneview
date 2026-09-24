import { s, type Schema } from '@worldview/world-model';

/**
 * A telemetry descriptor (ADR-003 amendment 2026-09-23, for phase `telemetry`): which numeric
 * payload keys of a source's observations are readings worth plotting over time, with their
 * display units, a fixed format and optional limits. It is data, carried on the manifest
 * (`ProviderManifest.telemetry`) so the renderer reads it through `providers.list`; a
 * connector definition carries it as `telemetry` (ADR-013). Values in payloads stay SI; the
 * descriptor never converts, it only labels.
 */
export const TELEMETRY_FORMATS = [
  'number:0',
  'number:1',
  'number:2',
  'percent',
  'celsius',
  'hpa',
  'mps',
  'kmh',
  'degrees',
  'ugm3',
  'ppm',
  'volts',
  'dbm',
] as const;
export type TelemetryFormat = (typeof TELEMETRY_FORMATS)[number];

export interface TelemetryLimits {
  warnLow?: number;
  warnHigh?: number;
  critLow?: number;
  critHigh?: number;
}

export interface TelemetrySeries {
  /** The payload key the values are read from (`payload[key]`, a number). */
  key: string;
  name: string;
  /** Display only (`°C`, `hPa`, `µg/m³`). */
  units?: string;
  format?: TelemetryFormat;
  /** The plot's fixed range; absent → fitted to the data. */
  min?: number;
  max?: number;
  limits?: TelemetryLimits;
}

export interface TelemetryDescriptor {
  series: TelemetrySeries[];
}

export const MAX_TELEMETRY_SERIES = 32;
const SERIES_KEY = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;

const limitsSchema = s.object({
  warnLow: s.optional(s.number()),
  warnHigh: s.optional(s.number()),
  critLow: s.optional(s.number()),
  critHigh: s.optional(s.number()),
}) as Schema<TelemetryLimits>;

export const telemetrySeriesSchema: Schema<TelemetrySeries> = s.refine(
  s.object({
    key: s.string({ min: 1, max: 64, pattern: SERIES_KEY }),
    name: s.string({ min: 1, max: 80 }),
    units: s.optional(s.string({ max: 16 })),
    format: s.optional(s.enum(TELEMETRY_FORMATS)),
    min: s.optional(s.number()),
    max: s.optional(s.number()),
    limits: s.optional(limitsSchema),
  }),
  (series) => {
    if (series.min !== undefined && series.max !== undefined && series.min >= series.max)
      return `series ${series.key}: min must be below max`;
    const l = series.limits;
    if (l) {
      const ordered = [l.critLow, l.warnLow, l.warnHigh, l.critHigh].filter((v): v is number => v !== undefined);
      for (let i = 1; i < ordered.length; i++)
        if (ordered[i]! < ordered[i - 1]!)
          return `series ${series.key}: limits must run critLow ≤ warnLow ≤ warnHigh ≤ critHigh`;
    }
    return undefined;
  },
) as Schema<TelemetrySeries>;

export const telemetryDescriptorSchema: Schema<TelemetryDescriptor> = s.refine(
  s.object({ series: s.array(telemetrySeriesSchema, { min: 1, max: MAX_TELEMETRY_SERIES }) }),
  (d) => {
    const keys = new Set<string>();
    for (const series of d.series) {
      if (keys.has(series.key)) return `series key ${series.key} appears twice`;
      keys.add(series.key);
    }
    return undefined;
  },
) as Schema<TelemetryDescriptor>;
