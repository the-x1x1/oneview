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
