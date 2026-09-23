import type { Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  buildObservation,
  type ProviderContext,
  type ProviderErrorInfo,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import { PUBLIC_CAMERAS_MANIFEST } from './manifest.js';
import { fintrafficPack } from './packs/fintraffic.js';
import { nswPack } from './packs/nsw.js';
import { tflPack } from './packs/tfl.js';
import { ontarioPack } from './packs/ontario.js';
import { drivebcPack } from './packs/drivebc.js';
import { calgaryPack } from './packs/calgary.js';
import type { CatalogPack } from './packs/types.js';

export { PUBLIC_CAMERAS_MANIFEST } from './manifest.js';
export {
  fintrafficPack,
  normalizeFintraffic,
  FINTRAFFIC_STATIONS_URL,
  FINTRAFFIC_FRAME_ORIGIN,
  DIGITRAFFIC_USER,
} from './packs/fintraffic.js';
export { nswPack, normalizeNsw, NSW_CAMERAS_URL, NSW_FRAME_HOST } from './packs/nsw.js';
export { tflPack, normalizeTfl, TFL_JAMCAM_URL, TFL_FRAME_PREFIX } from './packs/tfl.js';
export { ontarioPack, normalizeOntario, ONTARIO_511_CAMERAS_URL, ONTARIO_511_FRAME_ORIGIN } from './packs/ontario.js';
export {
  drivebcPack,
  normalizeDrivebc,
  partnerCredit,
  DRIVEBC_WEBCAMS_URL,
  DRIVEBC_FRAME_ORIGIN,
} from './packs/drivebc.js';
export {
  calgaryPack,
  normalizeCalgary,
  pinnedFrameUrl,
  CALGARY_CAMERAS_URL,
  CALGARY_FRAME_HOST,
} from './packs/calgary.js';
export { directionToHeading, normalizeHeading } from './direction.js';
export { isOnHost, matchesFrameHost } from './packs/types.js';
export type { CatalogPack, PackNormalizeOptions, PackNormalizeResult, PackCameraDraft } from './packs/types.js';

/**
 * Packs shipped with the provider. Every one's record is `approved` / `default` in the
 * legal registry with the same all-permitted data policy, so every one is on by default
 * (a pack whose record is not would need the aggregate record downgraded, or a provider
 * of its own — config/licenses/providers.json, `public-cameras` notes).
 *
 * Finland, New South Wales, London, Ontario, British Columbia and Calgary. The first two
 * were the only ones implemented until 2026-09-23, which is why cameras showed in two
 * countries; the other four had been cleared in the registry and never built.
 */
export const PUBLIC_CAMERA_PACKS: readonly CatalogPack[] = Object.freeze([
  fintrafficPack,
  nswPack,
  tflPack,
  ontarioPack,
  drivebcPack,
  calgaryPack,
]);

/** Frame hosts per pack — the camera gateway keeps an identical static list (cross-checked by test). */
export const PUBLIC_CAMERA_FRAME_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(PUBLIC_CAMERA_PACKS.map((p) => [p.id, p.frameHosts])),
);

export interface PublicCamerasSettings {
  /** Per-pack switches; a pack missing from the map is enabled. */
  packs?: Record<string, boolean>;
}

interface PackOutcome {
  pack: CatalogPack;
  observations: Observation[];
  cacheAgeMs: number;
}

export class PublicCamerasProvider extends PollingProvider {
  readonly manifest: ProviderManifest = PUBLIC_CAMERAS_MANIFEST;
  private settings: PublicCamerasSettings = {};
  private readonly packFailures = new Map<string, ProviderErrorInfo>();

  constructor(private readonly packs: readonly CatalogPack[] = PUBLIC_CAMERA_PACKS) {
    super();
  }

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.settings = parseSettings(await context.settings.get());
    context.settings.onChange((s) => {
      this.settings = parseSettings(s);
    });
  }

  enabledPacks(): CatalogPack[] {
    return this.packs.filter((p) => this.settings.packs?.[p.id] !== false);
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    const enabled = this.enabledPacks();
    if (enabled.length === 0) {
      this.packFailures.clear();
      return { observations: [], cacheAgeMs: 0 };
    }
    const settled = await Promise.allSettled(enabled.map((pack) => this.fetchPack(pack, request)));
    const observations: Observation[] = [];
    let cacheAgeMs = 0;
    let firstError: ProviderError | undefined;
    const nowIso = new Date(this.context.clock.now()).toISOString();
    settled.forEach((r, i) => {
      const pack = enabled[i]!;
      if (r.status === 'fulfilled') {
        observations.push(...r.value.observations);
        cacheAgeMs = Math.max(cacheAgeMs, r.value.cacheAgeMs);
        this.packFailures.delete(pack.id);
      } else {
        const pe =
          r.reason instanceof ProviderError
            ? r.reason
            : new ProviderError('INTERNAL', r.reason instanceof Error ? r.reason.message : String(r.reason), {
                cause: r.reason,
              });
        firstError ??= pe;
        if (pe.code !== 'CANCELLED') {
          this.packFailures.set(pack.id, pe.toInfo(nowIso));
          this.context.logger.warn('camera pack failed', { pack: pack.id, code: pe.code, message: pe.message });
        }
      }
    });
    if (firstError && observations.length === 0 && settled.every((r) => r.status === 'rejected')) throw firstError;
    return { observations, cacheAgeMs };
  }

  private async fetchPack(pack: CatalogPack, request: ProviderQuery): Promise<PackOutcome> {
    const res = await this.context.http.request({
      ...pack.request,
      signal: request.signal,
      cacheKey: pack.request.url,
    });
    let payload: unknown;
    try {
      payload = res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${pack.id} catalog is not valid JSON`, { retryable: false });
    }
    const now = this.context.clock.now();
    const receivedAt = new Date(now).toISOString();
    const observedAt = new Date(now - Math.max(0, res.ageMs)).toISOString();
    const result = pack.normalize(payload, {
      observedAt,
      origin: res.stale || res.fromCache ? 'cached' : 'live',
      sourceRef: pack.request.url,
      hash: (s) => this.context.hash.sha256Hex(s),
    });
    if (result.malformed) {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${pack.id} catalog has an unexpected shape`, { retryable: false });
    }
    if (result.total > 0 && result.drafts.length === 0) {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${pack.id} catalog: ${result.total} rows, none valid`, {
        retryable: false,
      });
    }
    if (result.rejected.length)
      this.context.logger.warn('rejected camera rows', {
        pack: pack.id,
        count: result.rejected.length,
        sample: result.rejected.slice(0, 3).map((r) => r.reason),
      });
    return {
      pack,
      observations: result.drafts.map((d) => buildObservation(this.manifest, receivedAt, d)),
      cacheAgeMs: res.ageMs,
    };
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (this.packFailures.size > 0 && h.status === 'LIVE') {
      const failing = [...this.packFailures.entries()];
      h.status = 'DEGRADED';
      h.message = failing.map(([pack, e]) => `${pack}: ${e.code}`).join('; ');
      h.lastError = failing[0]![1];
    }
    return h;
  }
}

function parseSettings(raw: Record<string, unknown>): PublicCamerasSettings {
  const out: PublicCamerasSettings = {};
  const packs = raw['packs'];
  if (packs && typeof packs === 'object' && !Array.isArray(packs)) {
    const map: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(packs as Record<string, unknown>))
      if (typeof v === 'boolean' && /^[a-z0-9-]{1,32}$/.test(k)) map[k] = v;
    out.packs = map;
  }
  return out;
}

export function createProvider(): PublicCamerasProvider {
  return new PublicCamerasProvider();
}
