import type { BasemapDescriptor, TerrainDescriptor } from './contract.js';

/**
 * Map-provider catalog (ADR-008): the basemaps and terrain sources WORLDVIEW can show,
 * independent of which renderer draws them. The runtime serves this over
 * `map.providers.list` with availability resolved against configured credentials, so the
 * interface never has to hardcode a list or guess what a build supports.
 *
 * Two rules from the commercial review are encoded here rather than in prose:
 * a `conditional` entry is never a default, and an entry that needs a credential is
 * reported unavailable (with the reason) until the operator supplies one. The defaults
 * are the zero-credential, offline-capable pair.
 */
export interface MapProviderEntry {
  id: string;
  name: string;
  kind: 'basemap' | 'terrain';
  /** Render modes that can show it. */
  modes: Array<'2D' | '3D'>;
  attribution: string;
  /** Works with no network (bundled assets or an installed world pack). */
  offlineCapable: boolean;
  /** Commercial review state from config/licenses (docs/legal/COMMERCIAL-DISTRIBUTION-REVIEW.md). */
  review: 'approved' | 'conditional';
  /** Credential key required before this entry can be selected. */
  requiresCredential?: string;
  termsUrl?: string;
  /** What the renderer is handed when this entry is selected. */
  descriptor: BasemapDescriptor | TerrainDescriptor;
  notes?: string;
  /**
   * What the desktop's disk tile cache may do with this source (apps/desktop/src/main/
   * tile-cache.ts). Absent means nothing: its tiles go straight to the network, which is
   * what OpenStreetMap's tile policy requires — no offline use, no bulk fetching.
   */
  tileCache?: {
    /** Upstream tile template with `{z}`, `{x}` and `{y}`. */
    upstream: string;
    maxZoom: number;
    /**
     * Whether the operator may switch on a whole-globe preload for it. Never automatic: the
     * setting is off by default, and whether the source's terms allow it is theirs to judge.
     */
    worldPreload: 'operator-decides' | 'never';
  };
}

export const DEFAULT_BASEMAP_ID = 'natural-earth';
/**
 * The basemap a new installation selects: Esri World Imagery, the operator's choice
 * (2026-09-24), in both modes. The approved, offline defaults above stay what each mode
 * falls back to when it cannot be drawn (offline with nothing cached, say).
 */
export const PREFERRED_BASEMAP_ID = 'esri-world-imagery';
export const DEFAULT_2D_BASEMAP_ID = 'worldview-dark';
export const DEFAULT_TERRAIN_ID = 'ellipsoid';

export const MAP_PROVIDER_CATALOG: readonly MapProviderEntry[] = Object.freeze([
  {
    id: DEFAULT_BASEMAP_ID,
    name: 'Natural Earth II (bundled)',
    kind: 'basemap',
    modes: ['3D'],
    attribution: 'Natural Earth II — public domain',
    offlineCapable: true,
    review: 'approved',
    descriptor: {
      kind: 'cesium-natural-earth',
      id: DEFAULT_BASEMAP_ID,
      attribution: 'Natural Earth II — public domain',
    },
    notes: 'Ships with Cesium; needs no network and no credential. The default and the recovery stack.',
  },
  {
    id: DEFAULT_2D_BASEMAP_ID,
    name: 'WORLDVIEW dark (offline vector)',
    kind: 'basemap',
    modes: ['2D'],
    attribution: '© OpenMapTiles © OpenStreetMap contributors',
    offlineCapable: true,
    review: 'approved',
    descriptor: {
      kind: 'pmtiles',
      id: DEFAULT_2D_BASEMAP_ID,
      url: '',
      styleId: 'worldview-dark',
      attribution: '© OpenMapTiles © OpenStreetMap contributors',
    },
    notes: 'Reads the PMTiles basemap of an installed world pack; the runtime fills in the pack path.',
  },
  {
    id: 'worldview-light',
    name: 'WORLDVIEW light (offline vector)',
    kind: 'basemap',
    modes: ['2D'],
    attribution: '© OpenMapTiles © OpenStreetMap contributors',
    offlineCapable: true,
    review: 'approved',
    descriptor: {
      kind: 'pmtiles',
      id: 'worldview-light',
      url: '',
      styleId: 'worldview-light',
      attribution: '© OpenMapTiles © OpenStreetMap contributors',
    },
  },
  {
    id: 'esri-world-imagery',
    name: 'Esri World Imagery',
    kind: 'basemap',
    modes: ['2D', '3D'],
    attribution: 'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics and the GIS User Community',
    offlineCapable: false,
    review: 'conditional',
    termsUrl: 'https://www.esri.com/en-us/legal/terms/full-master-agreement',
    descriptor: {
      kind: 'esri-world-imagery',
      id: 'esri-world-imagery',
      attribution: 'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics and the GIS User Community',
    },
    notes: 'Keyless today, but Esri governs the service; review the terms before commercial use (LR-06).',
    tileCache: {
      upstream: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 19,
      worldPreload: 'operator-decides',
    },
  },
  {
    id: 'osm-raster',
    name: 'OpenStreetMap raster',
    kind: 'basemap',
    modes: ['2D', '3D'],
    attribution: '© OpenStreetMap contributors',
    offlineCapable: false,
    review: 'conditional',
    termsUrl: 'https://operations.osmfoundation.org/policies/tiles/',
    descriptor: {
      kind: 'raster-xyz',
      id: 'osm-raster',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    },
    notes: 'The OSMF tile policy forbids offline use and bulk fetching; never a default (LR-07).',
  },
  {
    id: 'cesium-ion-bing',
    name: 'Bing Aerial with labels (Cesium ion)',
    kind: 'basemap',
    modes: ['3D'],
    attribution: 'Imagery via Cesium ion',
    offlineCapable: false,
    review: 'conditional',
    requiresCredential: 'cesium.ionToken',
    termsUrl: 'https://cesium.com/legal/terms-of-service/',
    descriptor: { kind: 'cesium-ion', id: 'cesium-ion-bing', assetId: 3, attribution: 'Imagery via Cesium ion' },
    notes: 'The ion free tier is non-commercial; bring your own token and check your tier (LR-08).',
  },
  {
    id: 'none',
    name: 'No basemap',
    kind: 'basemap',
    modes: ['2D', '3D'],
    attribution: '',
    offlineCapable: true,
    review: 'approved',
    descriptor: { kind: 'none', id: 'none' },
  },
  {
    id: DEFAULT_TERRAIN_ID,
    name: 'Ellipsoid (no terrain)',
    kind: 'terrain',
    modes: ['3D'],
    attribution: '',
    offlineCapable: true,
    review: 'approved',
    descriptor: { kind: 'ellipsoid' },
    notes: 'The offline default: no legally clear offline terrain source is bundled (ADR-007).',
  },
  {
    id: 'cesium-ion-world-terrain',
    name: 'Cesium World Terrain',
    kind: 'terrain',
    modes: ['3D'],
    attribution: 'Terrain via Cesium ion',
    offlineCapable: false,
    review: 'conditional',
    requiresCredential: 'cesium.ionToken',
    termsUrl: 'https://cesium.com/legal/terms-of-service/',
    descriptor: { kind: 'cesium-ion-world-terrain' },
  },
  {
    id: 'reearth-terrain',
    name: 'Re:Earth terrain (Mapterhorn)',
    kind: 'terrain',
    modes: ['3D'],
    attribution: 'Terrain: Re:Earth / Mapterhorn (CC BY 4.0)',
    offlineCapable: false,
    // `config/licenses/providers.json` records `reearth-terrain-mapterhorn` as
    // commercialReview "approved" with plannedStatus "default", and the commercial
    // distribution review lists it under §1.2 "Data providers enabled by default"
    // (CC BY 4.0 + EGM2008 public domain, keyless, commercial use allowed). The catalog
    // said "conditional" — code disagreeing with the review it cites, in the direction
    // that keeps the globe flat. The attribution CC BY requires is carried above and shown
    // with the other credits. `map-providers.test.ts` now ties the two together.
    review: 'approved',
    termsUrl: 'https://reearth.io/',
    descriptor: {
      kind: 'quantized-mesh',
      url: 'https://terrain.reearth.land/cesium-mesh/ellipsoid',
      attribution: 'Terrain: Re:Earth / Mapterhorn (CC BY 4.0)',
    },
    notes: 'Keyless quantized-mesh terrain with ellipsoidal heights; CC BY 4.0 attribution is required.',
  },
]);

export interface MapProviderAvailability {
  /** Credential keys the operator has configured. */
  credentials?: ReadonlySet<string> | readonly string[];
  /** True when an installed world pack supplies a PMTiles basemap. */
  offlineBasemapAvailable?: boolean;
  /** False when the application is offline: network-only entries become unavailable. */
  online?: boolean;
  /**
   * Sources with tiles in the desktop's disk cache. Offline, a network-only source that has
   * a `tileCache` block and tiles on disk stays selectable — it shows what was cached and
   * nothing more, and says so — instead of being taken away from an operator who switched
   * on the world preload precisely so it would work offline.
   */
  cachedTileSources?: ReadonlySet<string> | readonly string[];
}

export interface ResolvedMapProvider extends MapProviderEntry {
  available: boolean;
  unavailableReason?: string;
  /** Set when an entry is available with a limit worth knowing (offline: cached tiles only). */
  availableNote?: string;
}

export const OFFLINE_CACHED_NOTE = 'Offline: only the tiles already cached on this computer';

/** Resolve the catalog against what this installation actually has. */
export function resolveMapProviders(availability: MapProviderAvailability = {}): ResolvedMapProvider[] {
  const credentials =
    availability.credentials instanceof Set ? availability.credentials : new Set(availability.credentials ?? []);
  const online = availability.online ?? true;
  const cached =
    availability.cachedTileSources instanceof Set
      ? availability.cachedTileSources
      : new Set(availability.cachedTileSources ?? []);
  return MAP_PROVIDER_CATALOG.map((entry) => {
    if (entry.requiresCredential && !credentials.has(entry.requiresCredential)) {
      return {
        ...entry,
        available: false,
        unavailableReason: `Needs the ${entry.requiresCredential} credential (Settings → Sources)`,
      };
    }
    if (entry.descriptor.kind === 'pmtiles' && availability.offlineBasemapAvailable === false) {
      return {
        ...entry,
        available: false,
        unavailableReason: 'No installed world pack provides a basemap (Settings → Offline)',
      };
    }
    if (!entry.offlineCapable && !online) {
      if (entry.tileCache && cached.has(entry.id))
        return { ...entry, available: true, availableNote: OFFLINE_CACHED_NOTE };
      return { ...entry, available: false, unavailableReason: 'Unavailable while offline' };
    }
    return { ...entry, available: true };
  });
}

export function defaultBasemapFor(mode: '2D' | '3D'): string {
  return mode === '2D' ? DEFAULT_2D_BASEMAP_ID : DEFAULT_BASEMAP_ID;
}
