/**
 * The HUD's readouts as text (hud.tsx), pure so every format is tested. Each has a fixed
 * width for its kind of value — padded, never trimmed — so a readout that changes as the
 * camera moves does not make the text beside it jump.
 */

/** Longitude folded into [−180, 180): the 2D map reports an unwrapped one past the antimeridian. */
export function wrapLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** `21.30700° N  157.85831° W` — five decimals, about a metre. */
export function formatDecimal(latitude: number, longitude: number): string {
  const lon = wrapLongitude(longitude);
  const lat = `${Math.abs(latitude).toFixed(5).padStart(8, ' ')}° ${latitude < 0 ? 'S' : 'N'}`;
  const lng = `${Math.abs(lon).toFixed(5).padStart(9, ' ')}° ${lon < 0 ? 'W' : 'E'}`;
  return `${lat}  ${lng}`;
}

/** One angle as degrees, minutes and seconds to a tenth, carried correctly (59.96″ is 1′ 00.0″). */
function dms(value: number, degWidth: number): string {
  const tenths = Math.round(Math.abs(value) * 36_000);
  const deg = Math.floor(tenths / 36_000);
  const min = Math.floor((tenths % 36_000) / 600);
  const sec = (tenths % 600) / 10;
  return `${String(deg).padStart(degWidth, ' ')}°${String(min).padStart(2, '0')}′${sec.toFixed(1).padStart(4, '0')}″`;
}

/** `21°18′25.2″ N  157°51′29.9″ W`. */
export function formatDms(latitude: number, longitude: number): string {
  const lon = wrapLongitude(longitude);
  return `${dms(latitude, 2)} ${latitude < 0 ? 'S' : 'N'}  ${dms(lon, 3)} ${lon < 0 ? 'W' : 'E'}`;
}

/** Camera altitude: metres below 10 km, kilometres with one decimal below 1,000 km, whole kilometres above. */
export function formatAltitude(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  const m = Math.max(0, metres);
  if (m < 10_000) return `${Math.round(m).toLocaleString('en-US')} m`;
  if (m < 1_000_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000).toLocaleString('en-US')} km`;
}

/** 2D zoom, one decimal. */
export function formatZoom(zoom: number): string {
  return Number.isFinite(zoom) ? zoom.toFixed(1) : '—';
}

/** Heading as three digits of whole degrees, 000–359. */
export function formatHeading(degrees: number): string {
  const d = Math.round(((degrees % 360) + 360) % 360) % 360;
  return `${String(d).padStart(3, '0')}°`;
}

/** Pitch as both renderers report it: −90° looking straight down, 0° level with the horizon. */
export function formatPitch(degrees: number): string {
  const d = Math.round(Math.max(-90, Math.min(90, degrees)));
  return `${d < 0 ? '−' : d > 0 ? '+' : ' '}${String(Math.abs(d)).padStart(2, '0')}°`;
}

/** `2026-09-27 21:14:05Z`. */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}
