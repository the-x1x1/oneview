import type { GeoPosition } from '@worldview/world-model';
import { splitAtAntimeridian, type RenderFeature, type ViewState } from '@worldview/render-core';

/**
 * The latitude and longitude grid (G, Settings → Map): lines every so many degrees across what
 * the view shows, closer together as it closes in — about eight to twelve across the view —
 * with each parallel and meridian named once near the middle of the view. Drawn as map
 * features on its own layer, never pick targets, beneath everything else.
 */
export const GRATICULE_LAYER = 'graticule';
/** Spacings the grid steps through, widest first (degrees). */
export const GRATICULE_STEPS = [30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005] as const;
/** Lines do not go nearer the poles than this: the meridians crowd together there. */
const POLE_LIMIT = 85;

/** The widest spacing that still puts at most a dozen lines across `spanDeg`. */
export function graticuleSpacing(spanDeg: number): number {
  const want = Math.max(0, spanDeg) / 12;
  let pick: number = GRATICULE_STEPS[0];
  for (const s of GRATICULE_STEPS) if (s >= want) pick = s;
  return pick;
}

/** `30°N`, `0°`, `0.25°S`, `150°W`, `180°` — as many decimals as the spacing needs. */
export function formatGridLabel(value: number, axis: 'lat' | 'lon', spacing: number): string {
  const decimals = (String(spacing).split('.')[1] ?? '').length;
  const v = Number(value.toFixed(decimals));
  const text = Math.abs(v).toFixed(decimals);
  if (v === 0 || (axis === 'lon' && Math.abs(v) === 180)) return `${text}°`;
  return `${text}°${axis === 'lat' ? (v > 0 ? 'N' : 'S') : v > 0 ? 'E' : 'W'}`;
}

/** Into −180..180, keeping +180 itself (a parallel that goes all the way round ends there). */
function wrap(lon: number): number {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}

/** `k × spacing`, without the float noise that repeated addition piles up. */
function at(k: number, spacing: number): number {
  return Number((k * spacing).toFixed(6));
}

export interface GraticuleExtent {
  spacing: number;
  /** The view goes all the way round: parallels are whole circles. */
  whole: boolean;
  /** Line indexes (value = k × spacing), inclusive. */
  lonFrom: number;
  lonTo: number;
  latFrom: number;
  latTo: number;
  /** The meridian and the parallel the labels sit on, by index. */
  labelLon: number;
  labelLat: number;
}

/**
 * What the grid for a view covers, or undefined when the renderer has not said what the view
 * shows. Two views with the same extent draw the same grid, so the caller can skip a redraw.
 */
export function graticuleExtent(view: ViewState): GraticuleExtent | undefined {
  const b = view.bounds;
  if (!b) return undefined;
  let west = b.west;
  let east = b.east < b.west ? b.east + 360 : b.east;
  if (east - west >= 359) {
    west = -180;
    east = 180;
  }
  const south = Math.max(-POLE_LIMIT, Math.min(b.south, b.north));
  const north = Math.min(POLE_LIMIT, Math.max(b.south, b.north));
  const spacing = graticuleSpacing(Math.max(east - west, north - south));
  const whole = east - west >= 360 - spacing;
  const lonFrom = whole ? Math.ceil(-180 / spacing) : Math.floor(west / spacing);
  const lonTo = whole ? Math.floor(180 / spacing - 1e-9) : Math.ceil(east / spacing);
  const latFrom = Math.max(Math.ceil(-POLE_LIMIT / spacing), Math.floor(south / spacing));
  const latTo = Math.min(Math.floor(POLE_LIMIT / spacing), Math.ceil(north / spacing));
  const middle = view.focus ?? view.center;
  // The labels go on the meridian and parallel nearest the middle of the view, unwrapped into
  // the extent so a view across 180° still finds them.
  let midLon = middle.longitude;
  while (midLon < lonFrom * spacing) midLon += 360;
  while (midLon > lonTo * spacing) midLon -= 360;
  const labelLon = Math.min(lonTo, Math.max(lonFrom, Math.round(midLon / spacing)));
  const labelLat = Math.min(latTo, Math.max(latFrom, Math.round(middle.latitude / spacing)));
  return { spacing, whole, lonFrom, lonTo, latFrom, latTo, labelLon, labelLat };
}

/** The grid's lines and labels for an extent (see {@link graticuleExtent}). */
export function graticuleFeatures(e: GraticuleExtent): RenderFeature[] {
  const { spacing } = e;
  const out: RenderFeature[] = [];
  const latMin = at(e.latFrom, spacing);
  const latMax = at(e.latTo, spacing);
  const lonMin = e.whole ? -180 : at(e.lonFrom, spacing);
  const lonMax = e.whole ? 180 : at(e.lonTo, spacing);
  // A vertex at least every eighth of a spacing (two degrees at most), so a parallel curves
  // on the globe and a long meridian follows it.
  const step = Math.min(2, spacing / 8);
  const line = (id: string, positions: GeoPosition[]) => {
    splitAtAntimeridian(positions).forEach((piece, i) => {
      if (piece.length < 2) return;
      out.push({
        id: `${id}${i ? `:${i}` : ''}`,
        geometry: { kind: 'line', positions: piece },
        style: { styleClass: 'graticule', size: 1, opacity: 0.4, lineStyle: 'solid' },
        interactive: false,
        priority: 1,
        layer: GRATICULE_LAYER,
      });
    });
  };
  const label = (id: string, position: GeoPosition, text: string) =>
    out.push({
      id,
      geometry: { kind: 'point', position },
      style: { styleClass: 'graticule.label', size: 2, opacity: 0.8, label: text, labelPriority: 1 },
      interactive: false,
      priority: 1,
      layer: GRATICULE_LAYER,
    });

  const meridianLength = latMax - latMin;
  const meridianSteps = Math.max(1, Math.ceil(meridianLength / step));
  const labelLat = at(e.labelLat, spacing);
  // Meridian names sit halfway to the next parallel, clear of the parallel names.
  const meridianLabelLat = Math.min(latMax, labelLat + spacing / 2);
  for (let k = e.lonFrom; k <= e.lonTo; k++) {
    const lon = at(k, spacing) === 180 ? -180 : wrap(at(k, spacing));
    const positions: GeoPosition[] = [];
    for (let i = 0; i <= meridianSteps; i++)
      positions.push({ latitude: latMin + (meridianLength * i) / meridianSteps, longitude: lon });
    const name = formatGridLabel(lon, 'lon', spacing);
    line(`graticule:lon:${name}`, positions);
    if (meridianLength > 0) label(`graticule:label:lon:${name}`, { latitude: meridianLabelLat, longitude: lon }, name);
  }
  const parallelLength = lonMax - lonMin;
  const parallelSteps = Math.max(1, Math.ceil(parallelLength / step));
  const labelLon = wrap(at(e.labelLon, spacing));
  for (let k = e.latFrom; k <= e.latTo; k++) {
    const lat = at(k, spacing);
    const positions: GeoPosition[] = [];
    for (let i = 0; i <= parallelSteps; i++)
      positions.push({ latitude: lat, longitude: wrap(lonMin + (parallelLength * i) / parallelSteps) });
    const name = formatGridLabel(lat, 'lat', spacing);
    line(`graticule:lat:${name}`, positions);
    label(`graticule:label:lat:${name}`, { latitude: lat, longitude: labelLon }, name);
  }
  return out;
}
