import type {
  Gazetteer,
  GazetteerHit,
  GazetteerLookupOptions,
  GazetteerNearestOptions,
  NearbyPlace,
  PlaceKind as QueryPlaceKind,
} from '@worldview/query-engine';
import type { PlaceSearcher, PlaceKind as PackPlaceKind } from '@worldview/offline';
import { geodesicInverse, type GeoPosition } from '@worldview/world-model';

/**
 * Adapts the offline `PlaceIndex` (worldpack search indexes) to the query engine's
 * `Gazetteer`, so the same search grammar answers from installed packs without the
 * query engine knowing about worldpacks. The pack index is the authority for its
 * region; `CompositeGazetteer` merges it with the built-in fallback.
 */
const KIND_MAP: Readonly<Record<PackPlaceKind, QueryPlaceKind>> = Object.freeze({
  country: 'country',
  region: 'region',
  city: 'city',
  airport: 'airport',
  port: 'port',
  feature: 'poi',
  poi: 'poi',
});

export class PlaceIndexGazetteer implements Gazetteer {
  constructor(
    private readonly index: () => PlaceSearcher,
    readonly source = 'worldpack',
  ) {}

  lookup(name: string, opts: GazetteerLookupOptions = {}): GazetteerHit[] {
    const index = this.index();
    if (index.size === 0) return [];
    const kinds = opts.kinds ? packKindsFor(opts.kinds) : undefined;
    const hits = index.search(name, {
      limit: opts.limit ?? 10,
      ...(opts.bias ? { position: opts.bias } : {}),
      ...(kinds && kinds.length ? { kinds } : {}),
    });
    return hits.map((hit) => {
      const e = hit.entry;
      const out: GazetteerHit = {
        id: e.id,
        name: e.name,
        kind: KIND_MAP[e.kind],
        position: e.position,
        score: hit.score,
        source: this.source,
      };
      if (e.bounds) out.bounds = e.bounds;
      if (e.countryCode) out.countryCode = e.countryCode;
      return out;
    });
  }

  /** The pack places nearest a point (within 100 km unless asked otherwise), measured on the ellipsoid. */
  nearest(position: GeoPosition, opts: GazetteerNearestOptions = {}): NearbyPlace[] {
    const index = this.index();
    if (index.size === 0 || !index.nearest) return [];
    const kinds = packKindsFor(opts.kinds ?? ['city']);
    const hits = index.nearest(position, {
      limit: Math.max(1, opts.limit ?? 1) * 2,
      ...(opts.maxDistanceM !== undefined ? { maxDistanceM: opts.maxDistanceM } : {}),
      ...(kinds.length ? { kinds } : {}),
    });
    return hits
      .map((hit) => {
        const e = hit.entry;
        const g = geodesicInverse(e.position, position);
        const out: NearbyPlace = {
          id: e.id,
          name: e.name,
          kind: KIND_MAP[e.kind],
          position: e.position,
          distanceM: g.distanceM,
          bearingDeg: g.initialBearingDeg,
          importance: e.importance,
          source: this.source,
        };
        if (e.countryCode) out.countryCode = e.countryCode;
        return out;
      })
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, Math.max(1, opts.limit ?? 1));
  }
}

function packKindsFor(kinds: readonly QueryPlaceKind[]): PackPlaceKind[] {
  const wanted = new Set<QueryPlaceKind>(kinds);
  const out: PackPlaceKind[] = [];
  for (const [pack, query] of Object.entries(KIND_MAP) as Array<[PackPlaceKind, QueryPlaceKind]>) {
    if (wanted.has(query)) out.push(pack);
  }
  // 'island' has no pack equivalent; an island query still matches 'feature' entries.
  if (wanted.has('island') && !out.includes('feature')) out.push('feature');
  return out;
}

/**
 * A gazetteer that answers nothing until its data has loaded, then answers from it. The
 * reference labels are read from disk after start; search works meanwhile from the others.
 */
export class LateGazetteer implements Gazetteer {
  private inner: Gazetteer | undefined;

  set(gazetteer: Gazetteer): void {
    this.inner = gazetteer;
  }

  get ready(): boolean {
    return this.inner !== undefined;
  }

  lookup(name: string, opts?: GazetteerLookupOptions): GazetteerHit[] {
    return this.inner?.lookup(name, opts) ?? [];
  }

  nearest(position: GeoPosition, opts?: GazetteerNearestOptions): NearbyPlace[] {
    return this.inner?.nearest?.(position, opts) ?? [];
  }
}
