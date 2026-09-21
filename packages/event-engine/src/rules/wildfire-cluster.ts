import { EventTypes, ObjectTypes, haversineMeters, makeEventId, type JsonValue, type SeverityClass, type WorldEvent, type WorldObject } from '@worldview/world-model';
import { stableHash } from '@worldview/query-engine';
import { boundsOfPoints, footprintGeometry, roundCoord } from '../geometry.js';
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
 */
export const CLUSTER_LINK_DISTANCE_M = 5_000;
export const CLUSTER_LINK_WINDOW_MS = 24 * 3_600_000;
const CELL_DEG = 0.1;

interface Detection { obj: WorldObject; lat: number; lon: number; t: number; frp: number | undefined }

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
    for (const e of active) for (const id of e.objectIds) { const l = byMember.get(id) ?? []; l.push(e); byMember.set(id, l); }

    const out: WorldEvent[] = [];
    const claimed = new Set<string>();
    for (const members of clusters) {
      const first = members[0]!;
      const naturalId = makeEventId(EventTypes.WildfireCluster, 'worldview', stableHash(first.obj.id));
      const overlapping = uniqueEvents(members.flatMap((m) => byMember.get(m.obj.id) ?? [])).filter((e) => !claimed.has(e.id));
      overlapping.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id));
      const keep = overlapping[0];
      const id = keep ? keep.id : naturalId;
      claimed.add(id);
      out.push(clusterEvent(id, members, ctx));
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
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  const cells = new Map<string, number[]>();
  const key = (r: number, c: number) => `${r}:${c}`;
  for (let i = 0; i < n; i++) {
    const d = detections[i]!;
    const row = Math.floor(d.lat / CELL_DEG), col = Math.floor(d.lon / CELL_DEG);
    const lonReach = Math.max(1, Math.ceil((CLUSTER_LINK_DISTANCE_M / (111_320 * Math.max(0.05, Math.cos((d.lat * Math.PI) / 180)))) / CELL_DEG));
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -lonReach; dc <= lonReach; dc++) {
        const bucket = cells.get(key(row + dr, col + dc));
        if (!bucket) continue;
        for (const j of bucket) {
          const o = detections[j]!;
          if (Math.abs(o.t - d.t) > CLUSTER_LINK_WINDOW_MS) continue;
          if (haversineMeters({ latitude: d.lat, longitude: d.lon }, { latitude: o.lat, longitude: o.lon }) > CLUSTER_LINK_DISTANCE_M) continue;
          union(i, j);
        }
      }
    }
    const k = key(row, col);
    const list = cells.get(k);
    if (list) list.push(i); else cells.set(k, [i]);
  }
  const groups = new Map<number, Detection[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(detections[i]!); else groups.set(r, [detections[i]!]);
  }
  // Members are already in (t, id) order because detections were sorted; roots are the smallest index → cluster order follows first member.
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, members]) => members);
}

function uniqueEvents(events: WorldEvent[]): WorldEvent[] {
  const seen = new Map<string, WorldEvent>();
  for (const e of events) seen.set(e.id, e);
  return [...seen.values()];
}

export function clusterSeverity(count: number, frpSumMw: number | undefined): SeverityClass {
  if (count >= 50 || (frpSumMw !== undefined && frpSumMw >= 500)) return 'SEVERE';
  if (count >= 10) return 'MODERATE';
  return 'MINOR';
}

function clusterEvent(id: string, members: Detection[], ctx: RuleContext): WorldEvent {
  const objects = members.map((m) => m.obj);
  const points = members.map((m) => [roundCoord(m.lon), roundCoord(m.lat)] as [number, number]);
  const first = members[0]!, last = members[members.length - 1]!;
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
  const title = `Wildfire cluster — ${count} detection${count === 1 ? '' : 's'}${frpSum !== undefined ? ` (${Math.round(frpSum)} MW)` : ''}`;
  const summary = `${count} fire detection${count === 1 ? '' : 's'} linked within ${CLUSTER_LINK_DISTANCE_M / 1000} km and 24 h; first ${shortUtc(first.obj.observedAt)}, latest ${shortUtc(last.obj.observedAt)}${frpSum !== undefined ? `; total FRP ${Math.round(frpSum)} MW` : ''}; source${providers.length === 1 ? '' : 's'}: ${providers.join(', ')}.`;
  const geometry = footprintGeometry(points);
  const event: WorldEvent = {
    id,
    type: EventTypes.WildfireCluster,
    title,
    startAt: first.obj.observedAt,
    objectIds: objects.map((o) => o.id),
    observationRefs: refsOf(objects),
    confidence: confidenceOf(objects),
    severity: clusterSeverity(count, frpSum),
    summary,
    properties,
    provenance: derivedProvenance(objects, ctx.nowIso, refsOf(objects)),
  };
  if (geometry) event.geometry = geometry;
  return event;
}
