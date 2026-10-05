import type { WorldEvent } from '@worldview/world-model';

/**
 * The events an event names in its properties, as the selection panel lists them: the later
 * message that replaced an alert, the earlier ones an update replaces, the mainshock of an
 * aftershock (event-engine rules; roadmap 0.4 relationships).
 */
export interface EventLink {
  label: string;
  eventId: string;
}

const MAX_LINKS = 12;

export function eventLinks(ev: Pick<WorldEvent, 'properties'>): EventLink[] {
  const p = ev.properties ?? {};
  const out: EventLink[] = [];
  const by = p['supersededBy'];
  if (typeof by === 'string') out.push({ label: 'Replaced by a later message', eventId: by });
  const replaces = Array.isArray(p['supersedes'])
    ? p['supersedes'].filter((x): x is string => typeof x === 'string')
    : [];
  replaces.forEach((id, i) =>
    out.push({
      label: replaces.length === 1 ? 'Replaces an earlier message' : `Replaces earlier message ${i + 1}`,
      eventId: id,
    }),
  );
  const main = p['mainshockEventId'];
  if (typeof main === 'string') out.push({ label: 'Aftershock of', eventId: main });
  return out.slice(0, MAX_LINKS);
}

/** One line of an event's own history, newest first in the panel. */
export interface EventHistoryRow {
  at: string;
  text: string;
}

const MAX_HISTORY_ROWS = 12;

function lat(v: number): string {
  return `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`;
}
function lon(v: number): string {
  return `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}`;
}

/**
 * What an event recorded about itself over time (roadmap 0.4 event timelines): a storm's
 * advisory positions and strength, a fire cluster's size. Newest first, at most twelve, with
 * how many earlier ones there are.
 */
export function eventHistory(ev: Pick<WorldEvent, 'type' | 'properties'>): {
  rows: EventHistoryRow[];
  earlier: number;
} {
  const p = ev.properties ?? {};
  const rows: EventHistoryRow[] = [];
  const list = (key: string) => (Array.isArray(p[key]) ? (p[key] as unknown[]) : []);
  if (ev.type === 'storm') {
    for (const raw of list('track')) {
      const r = raw as Record<string, unknown>;
      if (typeof r['at'] !== 'string' || typeof r['latitude'] !== 'number' || typeof r['longitude'] !== 'number')
        continue;
      const kt = typeof r['intensityKt'] === 'number' ? `${r['intensityKt']} kt` : undefined;
      const cls = typeof r['classification'] === 'string' ? r['classification'] : undefined;
      rows.push({
        at: r['at'],
        text: [cls, kt, `${lat(r['latitude'])} ${lon(r['longitude'])}`].filter(Boolean).join(' · '),
      });
    }
  } else if (ev.type === 'wildfire-cluster') {
    for (const raw of list('growth')) {
      const r = raw as Record<string, unknown>;
      if (typeof r['at'] !== 'string' || typeof r['count'] !== 'number') continue;
      const area = typeof r['areaKm2'] === 'number' && r['areaKm2'] > 0 ? ` · ${r['areaKm2']} km²` : '';
      rows.push({ at: r['at'], text: `${r['count']} detection${r['count'] === 1 ? '' : 's'}${area}` });
    }
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { rows: rows.slice(0, MAX_HISTORY_ROWS), earlier: Math.max(0, rows.length - MAX_HISTORY_ROWS) };
}

/**
 * A mainshock's aftershock sequence (roadmap 0.5 event timelines): the earthquakes that name
 * it as their mainshock (event-engine withMainshock), from every event the shell holds.
 * Newest first, at most twelve rows, with the count, the largest and the span.
 */
export interface AftershockSequence {
  count: number;
  largest?: { eventId: string; magnitude: number };
  first: string;
  last: string;
  rows: Array<{ eventId: string; at: string; magnitude?: number; title: string }>;
  earlier: number;
}

export function aftershockSequence(
  mainshock: Pick<WorldEvent, 'id' | 'type'>,
  events: Iterable<WorldEvent>,
): AftershockSequence | undefined {
  if (mainshock.type !== 'earthquake') return undefined;
  const seen = new Set<string>();
  const shocks: WorldEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id) || e.type !== 'earthquake' || e.properties?.['mainshockEventId'] !== mainshock.id) continue;
    seen.add(e.id);
    shocks.push(e);
  }
  if (shocks.length === 0) return undefined;
  shocks.sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt) || (a.id < b.id ? -1 : 1));
  const mag = (e: WorldEvent) => {
    const m = e.properties?.['magnitude'];
    return typeof m === 'number' && Number.isFinite(m) ? m : undefined;
  };
  let largest: AftershockSequence['largest'];
  for (const e of shocks) {
    const m = mag(e);
    if (m !== undefined && (!largest || m > largest.magnitude)) largest = { eventId: e.id, magnitude: m };
  }
  const rows = shocks.slice(0, MAX_HISTORY_ROWS).map((e) => {
    const m = mag(e);
    return { eventId: e.id, at: e.startAt, title: e.title, ...(m !== undefined ? { magnitude: m } : {}) };
  });
  return {
    count: shocks.length,
    ...(largest ? { largest } : {}),
    first: shocks[shocks.length - 1]!.startAt,
    last: shocks[0]!.startAt,
    rows,
    earlier: Math.max(0, shocks.length - MAX_HISTORY_ROWS),
  };
}

/**
 * What an event recorded about itself as one number over time, for a small chart beside its
 * History: a fire cluster's detections, a storm's wind. Oldest first; undefined below two
 * points (nothing to draw a change with).
 */
export interface EventSeries {
  label: string;
  unit: string;
  points: Array<{ t: number; v: number }>;
}

export function eventSeries(ev: Pick<WorldEvent, 'type' | 'properties'>): EventSeries | undefined {
  const p = ev.properties ?? {};
  const list = (key: string) => (Array.isArray(p[key]) ? (p[key] as Array<Record<string, unknown>>) : []);
  let series: EventSeries | undefined;
  if (ev.type === 'wildfire-cluster')
    series = {
      label: 'Detections',
      unit: '',
      points: list('growth').flatMap((r) =>
        typeof r['at'] === 'string' && typeof r['count'] === 'number'
          ? [{ t: Date.parse(r['at']), v: r['count'] }]
          : [],
      ),
    };
  else if (ev.type === 'storm')
    series = {
      label: 'Wind',
      unit: 'kt',
      points: list('track').flatMap((r) =>
        typeof r['at'] === 'string' && typeof r['intensityKt'] === 'number'
          ? [{ t: Date.parse(r['at']), v: r['intensityKt'] }]
          : [],
      ),
    };
  if (!series) return undefined;
  series.points = series.points.filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
  return series.points.length >= 2 ? series : undefined;
}

/** The series as an SVG path in a `width`×`height` box, its lowest value at the bottom (at least 0). */
export function seriesPath(points: ReadonlyArray<{ t: number; v: number }>, width: number, height: number): string {
  if (points.length < 2) return '';
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const lo = Math.min(0, ...points.map((x) => x.v));
  const hi = Math.max(...points.map((x) => x.v));
  const span = t1 - t0 || 1;
  const range = hi - lo || 1;
  return points
    .map((x, i) => {
      const px = ((x.t - t0) / span) * width;
      const py = height - ((x.v - lo) / range) * height;
      return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join('');
}
