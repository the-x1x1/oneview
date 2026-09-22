import {
  boundsContain,
  parseObjectId,
  regionContains,
  type GeoBounds,
  type GeoRegion,
  type IsoTimestamp,
  type TimeRange,
} from '@worldview/world-model';
import type { HistoryRow } from './row.js';
import { mergeAvailability, type PartitionFilter, type PartitionKey, type PartitionMeta } from './partition.js';
import type { ObjectsAtOptions, RangeQuery, ReadResult, TypeAvailability, TypeCounts } from './backend.js';

/**
 * Query primitives implemented by scanning partitions. The partition index prunes
 * by type/provider/time; only candidate row files are opened. NdjsonBackend uses
 * these directly; DuckDbParquetBackend uses the reducers to merge SQL results with
 * rows still sitting in NDJSON staging files.
 */
export interface PartitionScanner {
  listPartitions(filter?: PartitionFilter): Promise<PartitionMeta[]>;
  readPartition(key: PartitionKey): Promise<ReadResult>;
}

export function lookbackRange(cursor: IsoTimestamp, lookbackSeconds: number): TimeRange {
  const end = Date.parse(cursor);
  const start = end - Math.max(0, lookbackSeconds) * 1000;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function inRange(row: HistoryRow, range: TimeRange): boolean {
  return row.observedAt >= range.start && row.observedAt <= range.end;
}

export function rowInBounds(row: HistoryRow, bounds: GeoBounds | undefined): boolean {
  if (!bounds) return true;
  if (row.lat === undefined || row.lon === undefined) return false;
  return boundsContain(bounds, { latitude: row.lat, longitude: row.lon });
}

export function rowInRegion(row: HistoryRow, region: GeoRegion | undefined): boolean {
  if (!region) return true;
  if (row.lat === undefined || row.lon === undefined) return false;
  return regionContains(region, { latitude: row.lat, longitude: row.lon });
}

/** Newest observation wins; ties on observedAt resolved by receivedAt then observationId (deterministic). */
export function isNewer(candidate: HistoryRow, current: HistoryRow): boolean {
  if (candidate.observedAt !== current.observedAt) return candidate.observedAt > current.observedAt;
  if (candidate.receivedAt !== current.receivedAt) return candidate.receivedAt > current.receivedAt;
  return candidate.observationId > current.observationId;
}

export function reduceLatestPerObject(
  rows: Iterable<HistoryRow>,
  into: Map<string, HistoryRow> = new Map(),
): Map<string, HistoryRow> {
  for (const row of rows) {
    const cur = into.get(row.objectId);
    if (!cur || isNewer(row, cur)) into.set(row.objectId, row);
  }
  return into;
}

export function sortByObjectId(rows: HistoryRow[]): HistoryRow[] {
  return rows.sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));
}

export function sortByObservedAt(rows: HistoryRow[]): HistoryRow[] {
  return rows.sort((a, b) =>
    a.observedAt < b.observedAt
      ? -1
      : a.observedAt > b.observedAt
        ? 1
        : a.observationId < b.observationId
          ? -1
          : a.observationId > b.observationId
            ? 1
            : 0,
  );
}

export async function scanObjectsAt(
  scanner: PartitionScanner,
  cursor: IsoTimestamp,
  opts: ObjectsAtOptions,
): Promise<HistoryRow[]> {
  const range = lookbackRange(cursor, opts.lookbackSeconds);
  const filter: PartitionFilter = {
    overlapping: range,
    ...(opts.objectTypes ? { objectTypes: opts.objectTypes } : {}),
    ...(opts.providerIds ? { providerIds: opts.providerIds } : {}),
  };
  const latest = new Map<string, HistoryRow>();
  for (const meta of await scanner.listPartitions(filter)) {
    const { rows } = await scanner.readPartition(meta);
    reduceLatestPerObject(
      rows.filter((r) => inRange(r, range) && rowInBounds(r, opts.bounds)),
      latest,
    );
  }
  const out = sortByObjectId([...latest.values()]);
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}

export async function scanTrack(scanner: PartitionScanner, objectId: string, range: TimeRange): Promise<HistoryRow[]> {
  const type = parseObjectId(objectId)?.type;
  const filter: PartitionFilter = { overlapping: range, ...(type ? { objectTypes: [type] } : {}) };
  const out: HistoryRow[] = [];
  for (const meta of await scanner.listPartitions(filter)) {
    const { rows } = await scanner.readPartition(meta);
    for (const r of rows) if (r.objectId === objectId && inRange(r, range)) out.push(r);
  }
  return sortByObservedAt(out);
}

export function availabilityFromMetas(
  metas: PartitionMeta[],
  objectTypes: string[] | undefined,
  gapToleranceMs: number,
): TypeAvailability[] {
  const byType = new Map<string, PartitionMeta[]>();
  for (const t of objectTypes ?? []) byType.set(t, []);
  for (const m of metas) {
    if (objectTypes && !objectTypes.includes(m.objectType)) continue;
    let list = byType.get(m.objectType);
    if (!list) {
      list = [];
      byType.set(m.objectType, list);
    }
    list.push(m);
  }
  return [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([objectType, list]) => ({ objectType, ranges: mergeAvailability(list, gapToleranceMs) }));
}

export function rangeFilter(query: RangeQuery): PartitionFilter {
  return {
    overlapping: query.range,
    ...(query.objectTypes ? { objectTypes: query.objectTypes } : {}),
    ...(query.providerIds ? { providerIds: query.providerIds } : {}),
  };
}

export function rowMatchesRange(row: HistoryRow, query: RangeQuery): boolean {
  return inRange(row, query.range) && rowInRegion(row, query.region);
}

export function reduceCounts(
  rows: Iterable<HistoryRow>,
  into: Map<string, { objects: Set<string>; rows: number }> = new Map(),
): Map<string, { objects: Set<string>; rows: number }> {
  for (const r of rows) {
    let c = into.get(r.objectType);
    if (!c) {
      c = { objects: new Set(), rows: 0 };
      into.set(r.objectType, c);
    }
    c.objects.add(r.objectId);
    c.rows++;
  }
  return into;
}

export function countsToList(
  map: Map<string, { objects: Set<string>; rows: number }>,
  objectTypes: string[] | undefined,
): TypeCounts[] {
  const types = objectTypes ?? [...map.keys()].sort();
  return types.map((objectType) => {
    const c = map.get(objectType);
    return { objectType, objects: c?.objects.size ?? 0, rows: c?.rows ?? 0 };
  });
}

export async function scanCounts(scanner: PartitionScanner, query: RangeQuery): Promise<TypeCounts[]> {
  const acc = new Map<string, { objects: Set<string>; rows: number }>();
  for (const meta of await scanner.listPartitions(rangeFilter(query))) {
    const { rows } = await scanner.readPartition(meta);
    reduceCounts(
      rows.filter((r) => rowMatchesRange(r, query)),
      acc,
    );
  }
  return countsToList(acc, query.objectTypes);
}

export async function scanObservationsInRange(scanner: PartitionScanner, query: RangeQuery): Promise<HistoryRow[]> {
  const out: HistoryRow[] = [];
  for (const meta of await scanner.listPartitions(rangeFilter(query))) {
    const { rows } = await scanner.readPartition(meta);
    for (const r of rows) if (rowMatchesRange(r, query)) out.push(r);
  }
  sortByObservedAt(out);
  return query.limit !== undefined ? out.slice(0, query.limit) : out;
}
