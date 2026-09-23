import {
  EventTypes,
  ObjectTypes,
  classifyConfidence,
  makeEventId,
  parseObjectId,
  type JsonValue,
  type SeverityClass,
  type WorldEvent,
  type WorldObject,
} from '@worldview/world-model';
import {
  derivedProvenance,
  numberProp,
  refsOf,
  shortUtc,
  stringProp,
  type ObjectRule,
  type RuleContext,
} from './types.js';

/**
 * stormRule — one event per tropical cyclone, carrying its track (roadmap 0.4 storm tracks).
 *
 *   id        event:storm:<namespace>:<value>   (storm:nhc-storms:al052026 → event:storm:nhc-storms:al052026)
 *   title     "<classification label> <name>", "(Category n)" for a hurricane
 *   severity  depression / post- or potential tropical cyclone → MINOR · tropical or subtropical
 *             storm → MODERATE · hurricane Category 1–2 → SEVERE · Category 3+ (≥ 96 kt) → EXTREME
 *   track     properties.track = the positions the storm has been seen at, one per advisory
 *             ({ at, latitude, longitude, intensityKt?, classification? }), carried from the
 *             stored event and bounded to 120 by thinning — the oldest point is kept
 *   trend     against the newest track point at least 12 h old: ≥ +15 kt "strengthening",
 *             ≤ −15 kt "weakening" (properties.trend, and said in the summary)
 *   geometry  the current centre (a Point) — what a watch zone and the feed locate it by
 *   end       an active storm event whose storm is no longer known gets endAt = now
 *             (advisories stopped, or the object expired)
 */
export const STORM_TRACK_MAX = 120;
export const STORM_TREND_WINDOW_MS = 12 * 3_600_000;
export const STORM_TREND_KT = 15;

export interface TrackPoint {
  at: string;
  latitude: number;
  longitude: number;
  intensityKt?: number;
  classification?: string;
}

export const stormRule: ObjectRule = {
  id: 'storm',
  objectTypes: [ObjectTypes.Storm],
  eventTypes: [EventTypes.Storm],
  scope: 'all',
  evaluate(objects, ctx) {
    const existing = new Map(ctx.existing(EventTypes.Storm).map((e) => [e.id, e] as const));
    const out: WorldEvent[] = [];
    const seen = new Set<string>();
    for (const o of objects) {
      if (o.type !== ObjectTypes.Storm || !o.position) continue;
      const parsed = parseObjectId(o.id);
      if (!parsed) continue;
      const id = makeEventId(EventTypes.Storm, parsed.namespace, parsed.value);
      seen.add(id);
      const previous = existing.get(id);
      const next = stormEvent(id, o, previous, ctx);
      if (!previous || !sameEvent(previous, next)) out.push(next);
    }
    for (const e of existing.values()) if (!e.endAt && !seen.has(e.id)) out.push({ ...e, endAt: ctx.nowIso });
    return out;
  },
};

/** Saffir–Simpson category from sustained wind in knots (hurricanes only). */
export function saffirSimpson(kt: number): 1 | 2 | 3 | 4 | 5 {
  if (kt >= 137) return 5;
  if (kt >= 113) return 4;
  if (kt >= 96) return 3;
  if (kt >= 83) return 2;
  return 1;
}

export function stormSeverity(classification: string | undefined, kt: number | undefined): SeverityClass {
  const c = (classification ?? '').toUpperCase();
  if (c === 'HU' || c === 'TY' || (kt !== undefined && kt >= 64)) {
    return kt !== undefined && kt >= 96 ? 'EXTREME' : 'SEVERE';
  }
  if (c === 'TS' || c === 'STS' || (kt !== undefined && kt >= 34)) return 'MODERATE';
  return 'MINOR';
}

function trackOf(e: WorldEvent | undefined): TrackPoint[] {
  const v = e?.properties?.['track'];
  if (!Array.isArray(v)) return [];
  const out: TrackPoint[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const r = p as Record<string, JsonValue>;
    const at = r['at'],
      lat = r['latitude'],
      lon = r['longitude'];
    if (typeof at !== 'string' || typeof lat !== 'number' || typeof lon !== 'number') continue;
    const point: TrackPoint = { at, latitude: lat, longitude: lon };
    if (typeof r['intensityKt'] === 'number') point.intensityKt = r['intensityKt'];
    if (typeof r['classification'] === 'string') point.classification = r['classification'];
    out.push(point);
  }
  return out;
}

/** The track with `now` added (unless it repeats the last point), thinned to STORM_TRACK_MAX. */
export function extendTrack(track: readonly TrackPoint[], now: TrackPoint): TrackPoint[] {
  const last = track[track.length - 1];
  const repeat =
    last &&
    (last.at === now.at ||
      (last.latitude === now.latitude && last.longitude === now.longitude && last.intensityKt === now.intensityKt));
  const out = repeat ? [...track] : [...track, now].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  while (out.length > STORM_TRACK_MAX) {
    let drop = 1;
    let gap = Number.POSITIVE_INFINITY;
    for (let i = 1; i < out.length - 1; i++) {
      const g = Date.parse(out[i]!.at) - Date.parse(out[i - 1]!.at);
      if (g < gap) {
        gap = g;
        drop = i;
      }
    }
    out.splice(drop, 1);
  }
  return out;
}

/** Strengthening or weakening against the newest point at least 12 h older than the last. */
export function stormTrend(
  track: readonly TrackPoint[],
): { trend: 'strengthening' | 'weakening'; fromKt: number; since: string } | undefined {
  const last = track[track.length - 1];
  if (!last || last.intensityKt === undefined) return undefined;
  const t = Date.parse(last.at);
  const earlier = [...track]
    .reverse()
    .find((p) => p.intensityKt !== undefined && t - Date.parse(p.at) >= STORM_TREND_WINDOW_MS);
  if (!earlier || earlier.intensityKt === undefined) return undefined;
  const d = last.intensityKt - earlier.intensityKt;
  if (d >= STORM_TREND_KT) return { trend: 'strengthening', fromKt: earlier.intensityKt, since: earlier.at };
  if (d <= -STORM_TREND_KT) return { trend: 'weakening', fromKt: earlier.intensityKt, since: earlier.at };
  return undefined;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function stormEvent(id: string, o: WorldObject, previous: WorldEvent | undefined, ctx: RuleContext): WorldEvent {
  const name = stringProp(o, 'name') ?? 'Unnamed';
  const classification = stringProp(o, 'classification');
  const label = stringProp(o, 'classificationLabel') ?? 'Tropical cyclone';
  const kt = numberProp(o, 'intensityKt');
  const pressure = numberProp(o, 'pressureMb');
  const dir = numberProp(o, 'movementDirDeg');
  const mph = numberProp(o, 'movementSpeedMph');
  const advisory = stringProp(o, 'advisoryNumber');
  const hurricane = (classification ?? '').toUpperCase() === 'HU';
  const category = hurricane && kt !== undefined ? saffirSimpson(kt) : undefined;
  const point: TrackPoint = { at: o.observedAt, latitude: o.position!.latitude, longitude: o.position!.longitude };
  if (kt !== undefined) point.intensityKt = kt;
  if (classification) point.classification = classification;
  const track = extendTrack(trackOf(previous), point);
  const trend = stormTrend(track);

  const parts: string[] = [];
  if (kt !== undefined) parts.push(`Maximum sustained winds ${kt} kt (${Math.round(kt * 1.15078)} mph)`);
  if (pressure !== undefined) parts.push(`pressure ${pressure} mb`);
  if (dir !== undefined && mph !== undefined)
    parts.push(
      `moving ${COMPASS[Math.round((((dir % 360) + 360) % 360) / 22.5) % 16]} (${Math.round(dir)}°) at ${mph} mph`,
    );
  let summary = parts.length ? `${parts.join(', ')}.` : '';
  summary += `${summary ? ' ' : ''}${advisory ? `Advisory ${advisory}, ` : 'As of '}${shortUtc(o.observedAt)}.`;
  if (trend)
    summary += ` ${trend.trend === 'strengthening' ? 'Strengthening' : 'Weakening'}: ${trend.fromKt} → ${kt} kt since ${shortUtc(trend.since)}.`;
  if (track.length > 1) summary += ` Track: ${track.length} positions since ${shortUtc(track[0]!.at)}.`;

  const properties: Record<string, JsonValue> = {
    name,
    track: track.map((p) => ({ ...p })),
  };
  if (classification) properties['classification'] = classification;
  if (kt !== undefined) properties['intensityKt'] = kt;
  if (pressure !== undefined) properties['pressureMb'] = pressure;
  if (category !== undefined) properties['category'] = category;
  if (advisory) properties['advisoryNumber'] = advisory;
  if (trend) properties['trend'] = trend.trend;
  const issuedAt = stringProp(o, 'advisoryIssuedAt');
  if (issuedAt) properties['issuedAt'] = issuedAt;

  const baseSeverity = stormSeverity(classification, kt);
  return {
    id,
    type: EventTypes.Storm,
    title: `${label} ${name}${category !== undefined ? ` (Category ${category})` : ''}`,
    startAt: track[0]!.at,
    objectIds: [o.id],
    observationRefs: refsOf([o]),
    confidence: classifyConfidence(o.confidence),
    severity: baseSeverity,
    summary,
    properties,
    geometry: { type: 'Point', coordinates: [o.position!.longitude, o.position!.latitude] },
    provenance:
      previous && sameContent(previous, { summary, properties })
        ? previous.provenance
        : derivedProvenance([o], ctx.nowIso, refsOf([o])),
  };
}

function sameContent(a: WorldEvent, b: { summary: string; properties: Record<string, JsonValue> }): boolean {
  return a.summary === b.summary && JSON.stringify(a.properties ?? {}) === JSON.stringify(b.properties);
}

/** Nothing the operator would see changed: no new event (the rule runs over every storm every batch). */
function sameEvent(a: WorldEvent, b: WorldEvent): boolean {
  return (
    a.title === b.title &&
    a.severity === b.severity &&
    a.startAt === b.startAt &&
    !a.endAt &&
    sameContent(a, { summary: b.summary, properties: (b.properties ?? {}) as Record<string, JsonValue> }) &&
    JSON.stringify(a.geometry) === JSON.stringify(b.geometry)
  );
}
