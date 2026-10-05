import type { SkyOverheadAnswer, SkySatellite } from '@worldview/ipc-contract';
import { compassPoint } from '../context/object-knowledge.js';

/**
 * The Sky tab's arithmetic (sky-panel.tsx): where a satellite goes on the polar plot, which
 * ones are drawn, and the line that sums them up. The plot is a GNSS receiver's sky plot —
 * the zenith in the middle, the horizon round the edge, north up and east to the right, as the
 * map is — not a star chart held overhead (east to the left).
 */
export const PLOT_RADIUS = 100;

/** Where a body at `azimuthDeg`, `elevationDeg` goes on the plot (centre 0,0; y down, as SVG). */
export function polarXY(azimuthDeg: number, elevationDeg: number, radius = PLOT_RADIUS): { x: number; y: number } {
  const r = (Math.max(0, Math.min(90, 90 - elevationDeg)) / 90) * radius;
  const a = (azimuthDeg * Math.PI) / 180;
  // `|| 0`: no −0 (the zenith, and due north or south) for a reader comparing numbers.
  const round = (v: number) => Math.round(v * 100) / 100 || 0;
  return { x: round(r * Math.sin(a)), y: round(-r * Math.cos(a)) };
}

/** Civil dusk is over: the Sun 6° or more below the horizon. */
export const DARK_SKY_SUN_DEG = -6;
/** Lower than this a satellite is lost in haze and buildings, sunlit or not. */
export const EYE_MIN_ELEVATION_DEG = 10;

/** Whether it could be seen with the eye now: lit by the Sun, in a dark sky, high enough. */
export function visibleToEye(s: SkySatellite, sunElevationDeg: number): boolean {
  return s.sunlit && sunElevationDeg <= DARK_SKY_SUN_DEG && s.elevationDeg >= EYE_MIN_ELEVATION_DEG;
}

export interface SkyFilter {
  hideStarlink: boolean;
  onlyVisible: boolean;
}

export function shownSatellites(answer: SkyOverheadAnswer, filter: SkyFilter): SkySatellite[] {
  return answer.satellites.filter(
    (s) =>
      !(filter.hideStarlink && s.category === 'starlink') &&
      !(filter.onlyVisible && !visibleToEye(s, answer.sunElevationDeg)),
  );
}

/** "37 above the horizon · 6 could be seen (sunlit, the sky dark)" — or why none can be seen. */
export function skySummary(answer: SkyOverheadAnswer): string {
  const above = `${answer.total.toLocaleString('en-US')} above the horizon`;
  if (answer.sunElevationDeg > DARK_SKY_SUN_DEG) return `${above} · the sky is not dark: none can be seen with the eye`;
  const eye = answer.satellites.filter((s) => visibleToEye(s, answer.sunElevationDeg)).length;
  return `${above} · ${eye.toLocaleString('en-US')} could be seen (sunlit, 10° up or more)`;
}

/** "62° up · 047° NE · 1,120 km". */
export function lookText(s: SkySatellite): string {
  const bearing = `${String(Math.round(s.azimuthDeg) % 360).padStart(3, '0')}° ${compassPoint(s.azimuthDeg)}`;
  return `${Math.round(s.elevationDeg)}° up · ${bearing} · ${Math.round(s.rangeM / 1000).toLocaleString('en-US')} km`;
}
