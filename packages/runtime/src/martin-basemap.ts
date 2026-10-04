import type { ResolvedMapProvider } from '@worldview/render-core';
import { readMartinBasemap, type MartinBasemap, type MartinResult, type MartinSourceConfig } from '@worldview/offline';

/**
 * A Martin tile server as 2D basemaps (offline-basemaps B4): the operator names one of its
 * sources in Settings → Rendering; `map.providers.list` reads its TileJSON
 * (`readMartinBasemap`, packages/offline) and offers it in WORLDVIEW's dark and light styles.
 *
 * What the map may load is where the renderer's Content Security Policy allows it: this
 * computer (loopback, plain http or https) or any https host. A server elsewhere on the
 * network over plain http is still read and checked, but listed as unavailable with the
 * reason — drawing it would mean widening the policy to that origin, which is the
 * operator's decision, not this code's.
 */
export const MARTIN_BASEMAP_IDS = { dark: 'martin-dark', light: 'martin-light' } as const;

/** How long one reading of the TileJSON is used before it is read again. */
export const MARTIN_CACHE_MS = 60_000;

export type MartinReader = (config: MartinSourceConfig) => Promise<MartinResult<MartinBasemap>>;

const unavailable = (reason: string): ResolvedMapProvider[] =>
  (['dark', 'light'] as const).map((variant) => ({
    id: MARTIN_BASEMAP_IDS[variant],
    name: `Martin tile server (${variant})`,
    kind: 'basemap' as const,
    modes: ['2D' as const],
    attribution: '',
    offlineCapable: true,
    review: 'approved' as const,
    descriptor: { kind: 'none' as const, id: MARTIN_BASEMAP_IDS[variant] },
    available: false,
    unavailableReason: reason,
  }));

/** The two entries for a basemap read from Martin, or both unavailable with why. */
export function martinProviderEntries(result: MartinResult<MartinBasemap>): ResolvedMapProvider[] {
  if (!result.ok) return unavailable(`Martin: ${result.reason}`);
  const b = result.value;
  if (b.access === 'trusted' && b.tiles.some((t) => t.startsWith('http:')))
    return unavailable(
      `Martin: ${new URL(b.tileJsonUrl).host} is on your network over plain http, which the map may not load; serve it over https or run Martin on this computer`,
    );
  return (['dark', 'light'] as const).map((variant) => ({
    id: MARTIN_BASEMAP_IDS[variant],
    name: `${b.name} (Martin, ${variant})`,
    kind: 'basemap' as const,
    modes: ['2D' as const],
    attribution: b.attribution,
    // The operator's own server: offline-capable when it runs here or on their network.
    offlineCapable: b.access !== 'public',
    review: 'approved' as const,
    descriptor: {
      kind: 'vector-tiles' as const,
      id: MARTIN_BASEMAP_IDS[variant],
      tiles: b.tiles,
      minZoom: b.minZoom,
      maxZoom: b.maxZoom,
      bounds: b.bounds,
      styleId: variant === 'light' ? ('worldview-light' as const) : ('worldview-dark' as const),
      attribution: b.attribution,
    },
    notes: `${b.tileJsonUrl} · credit from ${b.attributionFrom === 'tilejson' ? 'the TileJSON' : 'Settings'}`,
    available: true,
  }));
}

/**
 * The Martin entries for `map.providers.list`, read at most once a minute for the same
 * settings (the list is asked for on every connection and pack change). No setting, or an
 * empty URL, offers nothing.
 */
export class MartinBasemaps {
  private cached: { key: string; at: number; entries: ResolvedMapProvider[] } | undefined;

  constructor(
    private readonly read: MartinReader = (config) => readMartinBasemap(config),
    private readonly now: () => number = Date.now,
  ) {}

  async entries(
    config: { url: string; trustedHost: string; attribution: string } | undefined,
  ): Promise<ResolvedMapProvider[]> {
    const url = config?.url.trim() ?? '';
    if (!config || !url) {
      this.cached = undefined;
      return [];
    }
    const key = JSON.stringify([url, config.trustedHost.trim().toLowerCase(), config.attribution.trim()]);
    if (this.cached && this.cached.key === key && this.now() - this.cached.at < MARTIN_CACHE_MS)
      return this.cached.entries;
    const result = await this.read({
      url,
      ...(config.trustedHost.trim() ? { trustedHost: config.trustedHost.trim().toLowerCase() } : {}),
      ...(config.attribution.trim() ? { attribution: config.attribution.trim() } : {}),
    });
    const entries = martinProviderEntries(result);
    this.cached = { key, at: this.now(), entries };
    return entries;
  }
}
