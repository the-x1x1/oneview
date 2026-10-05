import type { NearbyPlaceResult } from '@worldview/ipc-contract';
import {
  geodesicInverse,
  moonIllumination,
  moonPosition,
  sunEvents,
  sunPosition,
  type GeoPosition,
} from '@worldview/world-model';
import type { JsonValue } from '@worldview/world-model';
import { compassPoint, noPassesText, passViews } from '../context/object-knowledge.js';
import { skyPositionText, skyTimeText } from '../context/sky-rows.js';
import { formatDistance } from './measure.js';
import { formatDecimal, formatDms, formatGridReference } from './hud-format.js';

/**
 * What's here, as text (whats-here.tsx draws it): the nearest town and where the point is from
 * it, the point's coordinates and grid reference, how far it is from home and from the
 * selection, and the Sun and Moon there. Pure, so every line is tested.
 */

export interface WhatsHereRow {
  label: string;
  value: string;
  /** A reference to copy (shown so it can be selected whole). */
  copyable?: boolean;
}

let regionNames: Intl.DisplayNames | null | undefined;

/** "United States" for "US"; the code as given when it is not one this system can name. */
export function countryName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Where the point is from the nearest town: "23.4 km NNE of Hilo" and, under it, "Hawaii,
 * United States". Within 1 km of the town's centre it is just the town.
 */
export function nearestPlaceText(place: NearbyPlaceResult): { title: string; subtitle?: string } {
  const where = [place.region, countryName(place.countryCode)].filter(Boolean).join(', ');
  const title =
    place.distanceM < 1000
      ? place.name
      : `${formatDistance(place.distanceM)} ${compassPoint(place.bearingDeg)} of ${place.name}`;
  return where ? { title, subtitle: where } : { title };
}

/** "123 km · 045° NE" — how far, and which way to go to get there. */
function fromText(from: GeoPosition, to: GeoPosition): string | undefined {
  const g = geodesicInverse(from, to);
  if (g.distanceM < 1) return undefined;
  const deg = g.initialBearingDeg;
  return `${formatDistance(g.distanceM)} · ${String(Math.round(deg) % 360).padStart(3, '0')}° ${compassPoint(deg)}`;
}

const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');

export interface WhatsHereInput {
  position: GeoPosition;
  nowMs: number;
  /** The grid reference chosen for the HUD; MGRS when none is. */
  grid?: 'mgrs' | 'utm';
  home?: GeoPosition;
  selection?: { name: string; position: GeoPosition };
}

export function whatsHereRows(input: WhatsHereInput): WhatsHereRow[] {
  const { position: p, nowMs } = input;
  const grid = input.grid ?? 'mgrs';
  const rows: WhatsHereRow[] = [
    { label: 'Coordinates', value: tidy(formatDecimal(p.latitude, p.longitude)), copyable: true },
    { label: 'DMS', value: tidy(formatDms(p.latitude, p.longitude)), copyable: true },
    {
      label: grid === 'utm' ? 'UTM' : 'MGRS',
      value: tidy(formatGridReference(p.latitude, p.longitude, grid)),
      copyable: true,
    },
  ];
  // How far, and which way: from home to here, and from the selection to here.
  const fromHome = input.home ? fromText(input.home, p) : undefined;
  if (fromHome) rows.push({ label: 'From home', value: fromHome });
  const fromSelection = input.selection ? fromText(input.selection.position, p) : undefined;
  if (fromSelection) rows.push({ label: `From ${input.selection!.name}`, value: fromSelection });

  const place = { latitude: p.latitude, longitude: p.longitude };
  const sun = sunPosition(nowMs, place);
  rows.push({ label: 'Sun', value: skyPositionText(sun) });
  const next = sunEvents(nowMs, place, 48).find((e) => e.kind === 'rise' || e.kind === 'set');
  rows.push({
    label: next?.kind === 'rise' ? 'Sunrise' : next ? 'Sunset' : 'Sunrise, sunset',
    value: next
      ? skyTimeText(next.at, nowMs)
      : sun.altitudeDeg > -0.8333
        ? 'none for two days: the Sun stays up'
        : 'none for two days: the Sun stays down',
  });
  const lit = moonIllumination(nowMs);
  const moon = moonPosition(nowMs, place);
  const moonAlt = Math.round(moon.altitudeDeg);
  rows.push({
    label: 'Moon',
    value: `${Math.round(lit.fraction * 100)}% lit, ${lit.phase} · ${moonAlt > 0 ? `${moonAlt}° up` : moonAlt < 0 ? 'below the horizon' : 'on the horizon'}`,
  });
  return rows;
}

/**
 * The selected satellite's next pass over the point, from its `world.details` answer asked for
 * there: "In 3h 12m · 10/05 06:41 UTC · 62° max" and whether it can be seen with the eye; a
 * plain sentence when none comes, or the answer said nothing about passes.
 */
export function nextPassRows(
  name: string,
  properties: Readonly<Record<string, JsonValue>>,
  nowMs: number,
): WhatsHereRow[] {
  const passes = passViews(properties, nowMs);
  if (!passes) return [];
  const label = `${name} here`;
  const first = passes[0];
  if (!first) return [{ label, value: noPassesText(properties) ?? 'No pass to come' }];
  const rows: WhatsHereRow[] = [{ label, value: `${first.when} · ${first.peak}` }];
  if (first.visibility)
    rows.push({ label: 'To the eye', value: first.visibility.replace(/^Visible to the eye /, 'visible ') });
  return rows;
}

/** The gap between the point and the card, and between the card and the map's edge, CSS px. */
const OFFSET = 12;
const MARGIN = 8;

/**
 * Where the card goes: below and right of the point, flipped left or up where it would run off
 * the map, and kept inside it. With no point (asked from the palette), the top right.
 */
export function cardPlacement(
  point: { x: number; y: number } | null,
  card: { width: number; height: number },
  map: { width: number; height: number },
): { x: number; y: number } {
  const clampX = (x: number) => Math.max(MARGIN, Math.min(map.width - card.width - MARGIN, x));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(map.height - card.height - MARGIN, y));
  if (!point) return { x: clampX(map.width - card.width - MARGIN), y: clampY(56) };
  const right = point.x + OFFSET;
  const below = point.y + OFFSET;
  const x = right + card.width + MARGIN <= map.width ? right : point.x - OFFSET - card.width;
  const y = below + card.height + MARGIN <= map.height ? below : point.y - OFFSET - card.height;
  return { x: clampX(x), y: clampY(y) };
}
