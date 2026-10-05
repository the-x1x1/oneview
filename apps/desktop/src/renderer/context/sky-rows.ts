import {
  moonEvents,
  moonIllumination,
  moonPosition,
  sunEvents,
  sunPosition,
  type GeoPosition,
  type SkyEvent,
  type SkyPosition,
} from '@worldview/world-model';
import { compassPoint } from './object-knowledge.js';

/**
 * The Sun and the Moon from where the selection is: how high each stands and where, when each
 * next rises and sets (and when civil twilight starts and ends), and how much of the Moon is
 * lit. Worked out offline from the clock (world-model sky.ts); times are UTC, rounded to the
 * minute as almanacs give them, with how long until each.
 */

export interface SkyRow {
  label: string;
  value: string;
}

/** Two days ahead: every rise and set comes round within that, except where it never does. */
const SEARCH_HOURS = 48;

/** "in 4h 16m", "in 38m", "now". */
function until(ms: number, nowMs: number): string {
  const m = Math.round((ms - nowMs) / 60_000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m}m`;
  return `in ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "16:24 UTC · in 16h 24m" — to the nearest minute. */
export function skyTimeText(ms: number, nowMs: number): string {
  const rounded = Math.round(ms / 60_000) * 60_000;
  return `${new Date(rounded).toISOString().slice(11, 16)} UTC · ${until(ms, nowMs)}`;
}

/** "54° up, bearing 226° SW" or "24° below the horizon, bearing 334° NNW". */
export function skyPositionText(p: SkyPosition): string {
  const bearing = `bearing ${String(Math.round(p.azimuthDeg) % 360).padStart(3, '0')}° ${compassPoint(p.azimuthDeg)}`;
  const alt = Math.round(p.altitudeDeg);
  if (alt > 0) return `${alt}° up, ${bearing}`;
  if (alt < 0) return `${-alt}° below the horizon, ${bearing}`;
  return `on the horizon, ${bearing}`;
}

const LABELS: Record<'sun' | 'moon', Record<SkyEvent['kind'], string>> = {
  sun: { rise: 'Sunrise', set: 'Sunset', dawn: 'Civil dawn', dusk: 'Civil dusk' },
  moon: { rise: 'Moonrise', set: 'Moonset', dawn: '', dusk: '' },
};

/** The next of each kind, in time order. */
function nextOfEach(events: SkyEvent[], kinds: SkyEvent['kind'][]): SkyEvent[] {
  return kinds
    .map((k) => events.find((e) => e.kind === k))
    .filter((e): e is SkyEvent => e !== undefined)
    .sort((a, b) => a.at - b.at);
}

export function skyRows(position: GeoPosition, nowMs: number): SkyRow[] {
  const place = { latitude: position.latitude, longitude: position.longitude };
  const rows: SkyRow[] = [];

  const sun = sunPosition(nowMs, place);
  rows.push({ label: 'Sun', value: skyPositionText(sun) });
  const sunAll = sunEvents(nowMs, place, SEARCH_HOURS);
  const sunNext = nextOfEach(sunAll, ['rise', 'set', 'dawn', 'dusk']);
  for (const e of sunNext) rows.push({ label: LABELS.sun[e.kind], value: skyTimeText(e.at, nowMs) });
  // Where it never comes round, say why rather than leave the row out.
  if (!sunAll.some((e) => e.kind === 'rise' || e.kind === 'set'))
    rows.push({
      label: 'Sunrise, sunset',
      value:
        sun.altitudeDeg > -0.8333 ? 'none for two days: the Sun stays up' : 'none for two days: the Sun stays down',
    });
  if (!sunAll.some((e) => e.kind === 'dawn' || e.kind === 'dusk'))
    rows.push({
      label: 'Civil twilight',
      value:
        sun.altitudeDeg > -6
          ? 'none for two days: the Sun stays above 6° below the horizon'
          : 'none for two days: the Sun stays more than 6° below the horizon',
    });

  const lit = moonIllumination(nowMs);
  rows.push({ label: 'Moon', value: `${Math.round(lit.fraction * 100)}% lit, ${lit.phase}` });
  const moon = moonPosition(nowMs, place);
  rows.push({ label: 'Moon now', value: skyPositionText(moon) });
  const moonAll = moonEvents(nowMs, place, SEARCH_HOURS);
  for (const e of nextOfEach(moonAll, ['rise', 'set']))
    rows.push({ label: LABELS.moon[e.kind], value: skyTimeText(e.at, nowMs) });
  if (!moonAll.length)
    rows.push({
      label: 'Moonrise, moonset',
      value:
        moon.altitudeDeg > -0.8333 ? 'none for two days: the Moon stays up' : 'none for two days: the Moon stays down',
    });
  return rows;
}
