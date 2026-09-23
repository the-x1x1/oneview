import {
  EventTypes,
  ObjectTypes,
  haversineMeters,
  makeEventId,
  type JsonValue,
  type SeverityClass,
  type WorldEvent,
  type WorldObject,
} from '@worldview/world-model';
import { stableHash } from '@worldview/query-engine';
import { boundsOfPoints, convexHull, footprintGeometry, roundCoord } from '../geometry.js';
import { confidenceOf } from '../severity.js';
import { derivedProvenance, numberProp, refsOf, shortUtc, type ObjectRule, type RuleContext } from './types.js';

/**
 * wildfireClusterRule — fire detections → clusters.
 *
 *   linkage   single-linkage: two detections join when ≤ 5 km apart and ≤ 24 h apart (grid-accelerated)
 *   identity  event:wildfire-cluster:worldview:<hash(earliest detection id)>; an existing cluster that
 *             shares a member keeps its id (earliest startAt wins); merged clusters are ended with
 *             properties.mergedInto; clusters whose detections all expired are ended.
 *   severity  ≥ 50 detections or FRP sum ≥ 500 MW → SEVERE · ≥ 10 detections → MODERATE · else MINOR
 *   geometry  convex hull polygon (≥ 3 non-collinear points) or padded bounding box
 *   growth    (roadmap 0.4) properties.areaKm2 = the hull's area; properties.growth = a bounded
 *             history of { at, count, areaKm2 }, one entry each time either changes. A cluster
 *             that, against its size at least 6 h earlier, has half again as many detections
 *             (and 10 more) or twice the area (and 5 km² more) is `growing`: the title says so
 *             and its severity is one class higher, at most SEVERE — so a watch zone escalates.
 */
export const CLUSTER_LINK_DISTANCE_M = 5_000;
export const CLUSTER_LINK_WINDOW_MS = 24 * 3_600_000;
const CELL_DEG = 0.1;

interface Detection {
  obj: WorldObject;
  lat: number;
  lon: number;
  t: number;
  frp: number | undefined;
}

export const wildfireClusterRule: ObjectRule = {
  id: 'wildfire-cluster',
  objectTypes: [ObjectTypes.FireDetection],
  eventTypes: [EventTypes.WildfireCluster],
  scope: 'all',
  evaluate(objects, ctx) {
    const detections = collect(objects);
    const clusters = clusterDetections(detections);
    const existing = ctx.existing(EventTypes.WildfireCluster);
    const active = existing.filter((e) => !e.endAt);
    const byMember = new Map<string, WorldEvent[]>();
    for (const e of active)
      for (const id of e.objectIds) {
        const l = byMember.get(id) ?? [];
        l.push(e);
        byMember.set(id, l);
      }

    const out: WorldEvent[] = [];
    const claimed = new Set<string>();
    for (const members of clusters) {
      const first = members[0]!;
      const naturalId = makeEventId(EventTypes.WildfireCluster, 'worldview', stableHash(first.obj.id));
      const overlapping = uniqueEvents(members.flatMap((m) => byMember.get(m.obj.id) ?? [])).filter(
        (e) => !claimed.has(e.id),
      );
      overlapping.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id));
      const keep = overlapping[0];
      const id = keep ? keep.id : naturalId;
      claimed.add(id);
      out.push(clusterEvent(id, members, ctx, keep));
      for (const merged of overlapping.slice(1)) {
        claimed.add(merged.id);
        out.push({ ...merged, endAt: ctx.nowIso, properties: { ...(merged.properties ?? {}), mergedInto: id } });
      }
    }
    // Active clusters with no surviving detections have ended.
    for (const e of active) if (!claimed.has(e.id)) out.push({ ...e, endAt: ctx.nowIso });
    return out;
  },
};

function collect(objects: readonly WorldObject[]): Detection[] {
  const out: Detection[] = [];
  for (const o of objects) {
    if (o.type !== ObjectTypes.FireDetection || !o.position) continue;
    const t = Date.parse(o.observedAt);
    if (!Number.isFinite(t)) continue;
    out.push({ obj: o, lat: o.position.latitude, lon: o.position.longitude, t, frp: numberProp(o, 'frpMw', 'frp') });
  }
  out.sort((a, b) => a.t - b.t || (a.obj.id < b.obj.id ? -1 : a.obj.id > b.obj.id ? 1 : 0));
  return out;
}

/** Single-linkage clustering; returns clusters as member lists sorted by (observedAt, id), clusters ordered by their first member. */
export function clusterDetections(detections: readonly Detection[]): Detection[][] {
  const n = detections.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const cells = new Map<string, number[]>();
  const key = (r: number, c: number) => `${r}:${c}`;
  for (let i = 0; i < n; i++) {
    const d = detections[i]!;
    const row = Math.floor(d.lat / CELL_DEG),
      col = Math.floor(d.lon / CELL_DEG);
    const lonReach = Math.max(
      1,
      Math.ceil(CLUSTER_LINK_DISTANCE_M / (111_320 * Math.max(0.05, Math.cos((d.lat * Math.PI) / 180))) / CELL_DEG),
    );
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -lonReach; dc <= lonReach; dc++) {
        const bucket = cells.get(key(row + dr, col + dc));
        if (!bucket) continue;
        for (const j of bucket) {
          const o = detections[j]!;
          if (Math.abs(o.t - d.t) > CLUSTER_LINK_WINDOW_MS) continue;
          if (
            haversineMeters({ latitude: d.lat, longitude: d.lon }, { latitude: o.lat, longitude: o.lon }) >
            CLUSTER_LINK_DISTANCE_M
          )
            continue;
          union(i, j);
        }
      }
    }
    const k = key(row, col);
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  }
  const groups = new Map<number, Detection[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(detections[i]!);
    else groups.set(r, [detections[i]!]);
  }
  // Members are already in (t, id) order because detections were sorted; roots are the smallest index → cluster order follows first member.
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, members]) => members);
}

function uniqueEvents(events: WorldEvent[]): WorldEvent[] {
  const seen = new Map<string, WorldEvent>();
  for (const e of events) seen.set(e.id, e);
  return [...seen.values()];
}

export const GROWTH_WINDOW_MS = 6 * 3_600_000;
export const GROWTH_HISTORY = 24;

/** Area of the points' convex hull in km² (a local equirectangular projection; fires are small). */
export function hullAreaKm2(points: ReadonlyArray<[number, number]>): number {
  const hull = convexHull(points);
  if (hull.length < 3) return 0;
  const meanLat = hull.reduce((n, p) => n + p[1], 0) / hull.length;
  const kx = 111.32 * Math.cos((meanLat * Math.PI) / 180);
  const ky = 110.57;
  let twice = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i]!;
    const [x2, y2] = hull[(i + 1) % hull.length]!;
    twice += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return Math.abs(twice) / 2;
}

interface GrowthPoint {
  at: string;
  count: number;
  areaKm2: number;
}

function growthOf(e: WorldEvent | undefined): GrowthPoint[] {
  const v = e?.properties?.['growth'];
  if (!Array.isArray(v)) return [];
  const out: GrowthPoint[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const r = p as Record<string, JsonValue>;
    if (typeof r['at'] === 'string' && typeof r['count'] === 'number' && typeof r['areaKm2'] === 'number')
      out.push({ at: r['at'], count: r['count'], areaKm2: r['areaKm2'] });
  }
  return out;
}

/** The history with this run's size appended when it changed, and whether the cluster is growing. */
export function clusterGrowth(
  previous: readonly GrowthPoint[],
  now: GrowthPoint,
): { history: GrowthPoint[]; growing: boolean; since?: GrowthPoint } {
  const last = previous[previous.length - 1];
  const history = last && last.count === now.count && last.areaKm2 === now.areaKm2 ? [...previous] : [...previous, now];
  // Bounded by thinning, not by dropping the oldest: many small changes in an afternoon must
  // not push out the entry from six hours ago that growth is measured against.
  const bounded = [...history];
  while (bounded.length > GROWTH_HISTORY) {
    let drop = 1;
    let gap = Number.POSITIVE_INFINITY;
    for (let i = 1; i < bounded.length - 1; i++) {
      const g = Date.parse(bounded[i]!.at) - Date.parse(bounded[i - 1]!.at);
      if (g < gap) {
        gap = g;
        drop = i;
      }
    }
    bounded.splice(drop, 1);
  }
  const nowMs = Date.parse(now.at);
  // The newest size at least the window old; failing that, the oldest known.
  const earlier = [...bounded].reverse().find((p) => nowMs - Date.parse(p.at) >= GROWTH_WINDOW_MS);
  if (!earlier) return { history: bounded, growing: false };
  const more = now.count >= earlier.count * 1.5 && now.count - earlier.count >= 10;
  const wider = now.areaKm2 >= earlier.areaKm2 * 2 && now.areaKm2 - earlier.areaKm2 >= 5;
  return more || wider ? { history: bounded, growing: true, since: earlier } : { history: bounded, growing: false };
}

const RAISE: Record<SeverityClass, SeverityClass> = {
  INFO: 'MINOR',
  MINOR: 'MODERATE',
  MODERATE: 'SEVERE',
  SEVERE: 'SEVERE',
  EXTREME: 'EXTREME',
};

export function clusterSeverity(count: number, frpSumMw: number | undefined): SeverityClass {
  if (count >= 50 || (frpSumMw !== undefined && frpSumMw >= 500)) return 'SEVERE';
  if (count >= 10) return 'MODERATE';
  return 'MINOR';
}

function clusterEvent(id: string, members: Detection[], ctx: RuleContext, previous?: WorldEvent): WorldEvent {
  const objects = members.map((m) => m.obj);
  const points = members.map((m) => [roundCoord(m.lon), roundCoord(m.lat)] as [number, number]);
  const first = members[0]!,
    last = members[members.length - 1]!;
  const frpValues = members.map((m) => m.frp).filter((v): v is number => v !== undefined);
  const frpSum = frpValues.length ? Math.round(frpValues.reduce((a, b) => a + b, 0) * 10) / 10 : undefined;
  const count = members.length;
  const providers = [...new Set(objects.map((o) => o.provenance.providerId))].sort();
  const bounds = boundsOfPoints(points)!;
  const properties: Record<string, JsonValue> = {
    detectionCount: count,
    firstDetectionId: first.obj.id,
    firstDetectionAt: first.obj.observedAt,
    lastDetectionAt: last.obj.observedAt,
    bounds: { west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north },
    providers,
  };
  if (frpSum !== undefined) properties['frpSumMw'] = frpSum;
  const areaKm2 = Math.round(hullAreaKm2(points) * 10) / 10;
  properties['areaKm2'] = areaKm2;
  const growth = clusterGrowth(growthOf(previous), { at: ctx.nowIso, count, areaKm2 });
  properties['growth'] = growth.history.map((p) => ({ at: p.at, count: p.count, areaKm2: p.areaKm2 }));
  if (growth.growing) properties['growing'] = true;
  const title = `Wildfire cluster — ${count} detection${count === 1 ? '' : 's'}${frpSum !== undefined ? ` (${Math.round(frpSum)} MW)` : ''}${growth.growing ? ' — growing' : ''}`;
  const summary = `${count} fire detection${count === 1 ? '' : 's'} linked within ${CLUSTER_LINK_DISTANCE_M / 1000} km and 24 h; first ${shortUtc(first.obj.observedAt)}, latest ${shortUtc(last.obj.observedAt)}${frpSum !== undefined ? `; total FRP ${Math.round(frpSum)} MW` : ''}; source${providers.length === 1 ? '' : 's'}: ${providers.join(', ')}.`;
  const footprint = areaKm2 > 0 ? ` Footprint about ${areaKm2} km².` : '';
  const since = growth.since
    ? ` Growing: ${growth.since.count} → ${count} detections, ${growth.since.areaKm2} → ${areaKm2} km² since ${shortUtc(growth.since.at)}.`
    : '';
  const geometry = footprintGeometry(points);
  const event: WorldEvent = {
    id,
    type: EventTypes.WildfireCluster,
    title,
    startAt: first.obj.observedAt,
    objectIds: objects.map((o) => o.id),
    observationRefs: refsOf(objects),
    confidence: confidenceOf(objects),
    severity: growth.growing ? RAISE[clusterSeverity(count, frpSum)] : clusterSeverity(count, frpSum),
    summary: `${summary}${footprint}${since}`,
    properties,
    provenance: derivedProvenance(objects, ctx.nowIso, refsOf(objects)),
  };
  if (geometry) event.geometry = geometry;
  return event;
}
