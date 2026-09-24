import type { TelemetryFormat, TelemetryLimits, TelemetrySeries } from '@worldview/provider-sdk';

/**
 * What each fixed format means: decimals and the unit shown when the series names none.
 * A format labels, it never converts — payloads are SI and a `kmh` series is one whose
 * source already reports km/h. The record is keyed by the format type, so a format added to
 * the SDK fails the typecheck here until it has an entry.
 */
export const FORMAT_RULES: Readonly<Record<TelemetryFormat, { decimals: number; units?: string }>> = {
  'number:0': { decimals: 0 },
  'number:1': { decimals: 1 },
  'number:2': { decimals: 2 },
  percent: { decimals: 0, units: '%' },
  celsius: { decimals: 1, units: '°C' },
  hpa: { decimals: 1, units: 'hPa' },
  mps: { decimals: 1, units: 'm/s' },
  kmh: { decimals: 0, units: 'km/h' },
  degrees: { decimals: 0, units: '°' },
  ugm3: { decimals: 1, units: 'µg/m³' },
  ppm: { decimals: 0, units: 'ppm' },
  volts: { decimals: 2, units: 'V' },
  dbm: { decimals: 0, units: 'dBm' },
};

/** Without a format: up to two decimals, trailing zeros dropped. */
const FREE_DECIMALS = 2;

/** The unit a series is shown in: its own, else its format's, else none. */
export function seriesUnits(series: Pick<TelemetrySeries, 'units' | 'format'>): string | undefined {
  return series.units ?? (series.format ? FORMAT_RULES[series.format].units : undefined);
}

/** A value as the panel shows it: `21.4 °C`, `63 %`, `250°`, `1,013.2 hPa`, `12.35`. */
export function formatReading(value: number, series: Pick<TelemetrySeries, 'units' | 'format'>): string {
  if (!Number.isFinite(value)) return '—';
  const rule = series.format ? FORMAT_RULES[series.format] : undefined;
  const text = value.toLocaleString('en-US', {
    minimumFractionDigits: rule ? rule.decimals : 0,
    maximumFractionDigits: rule ? rule.decimals : FREE_DECIMALS,
  });
  // `-0.0` reads as a bug in a panel.
  const shown = /^-0(?:\.0+)?$/.test(text) ? text.slice(1) : text;
  const units = seriesUnits(series);
  if (!units) return shown;
  return units === '°' ? `${shown}°` : `${shown} ${units}`;
}

export type LimitState = 'crit-low' | 'warn-low' | 'normal' | 'warn-high' | 'crit-high';

/** Where a value sits against the limits; a value on a limit is inside it. */
export function limitState(value: number, limits: TelemetryLimits | undefined): LimitState {
  if (!limits) return 'normal';
  if (limits.critHigh !== undefined && value > limits.critHigh) return 'crit-high';
  if (limits.critLow !== undefined && value < limits.critLow) return 'crit-low';
  if (limits.warnHigh !== undefined && value > limits.warnHigh) return 'warn-high';
  if (limits.warnLow !== undefined && value < limits.warnLow) return 'warn-low';
  return 'normal';
}

/** Words for a state, for the latest value's note and the chart's accessible text. */
export function limitText(state: LimitState): string | undefined {
  switch (state) {
    case 'crit-high':
      return 'above the critical limit';
    case 'crit-low':
      return 'below the critical limit';
    case 'warn-high':
      return 'above the warning limit';
    case 'warn-low':
      return 'below the warning limit';
    default:
      return undefined;
  }
}
