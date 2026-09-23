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
import { hongKongPack } from './packs/hongkong.js';
import { icelandPack } from './packs/iceland.js';
import { queenslandPack } from './packs/queensland.js';
import { trafikverketPack } from './packs/trafikverket.js';
import { UNVERIFIED_CAMERA_PACKS } from './unverified/packs.js';
import { PUBLIC_CAMERAS_UNVERIFIED_MANIFEST } from './unverified/manifest.js';
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
export {
  hongKongPack,
  normalizeHongKong,
  parseFlatXmlRecords,
  HONG_KONG_CAMERAS_URL,
  HONG_KONG_FRAME_HOST,
} from './packs/hongkong.js';
export { icelandPack, normalizeIceland, ICELAND_CAMERAS_URL, ICELAND_FRAME_PREFIX } from './packs/iceland.js';
export {
  queenslandPack,
  normalizeQueensland,
  QLD_WEBCAMS_URL,
  QLD_FRAME_HOST,
  QLD_PUBLIC_API_KEY,
} from './packs/queensland.js';
export {
  trafikverketPack,
  normalizeTrafikverket,
  parseWktPoint,
  TRAFIKVERKET_URL,
  TRAFIKVERKET_QUERY,
  TRAFIKVERKET_CREDENTIAL,
  TRAFIKVERKET_FRAME_PREFIXES,
} from './packs/trafikverket.js';
export { PUBLIC_CAMERAS_UNVERIFIED_MANIFEST } from './unverified/manifest.js';
export { UNVERIFIED_CAMERA_PACKS } from './unverified/packs.js';
export { caltransPack, normalizeCaltrans, caltransUrl, CALTRANS_DISTRICTS } from './unverified/caltrans.js';
export {
  austinPack,
  nycPack,
  iowaPack,
  AUSTIN_CAMERAS_URL,
  NYC_CAMERAS_URL,
  IOWA_CAMERAS_URL,
  IOWA_PAGE_ROWS,
  iowaUrl,
} from './unverified/us-cities.js';
export { directionToHeading, normalizeHeading } from './direction.js';
export { isOnHost, matchesFrameHost } from './packs/types.js';
export type { CatalogPack, PackNormalizeOptions, PackNormalizeResult, PackCameraDraft } from './packs/types.js';

/**
 * Packs shipped with the provider. Every one's record is `approved` / `default` in the
 * legal registry with the same all-permitted data policy, so every one is on by default
 * (a pack whose record is not goes in `public-cameras-unverified`, which is off by
 * default — config/licenses/providers.json, `public-cameras` notes).
 *
 * Finland, New South Wales, London, Ontario, British Columbia, Calgary, Hong Kong, Iceland,
 * Queensland, and Sweden once the operator has stored a Trafikverket key. The first two
 * were the only ones implemented until 2026-09-23, which is why cameras showed in two
 * countries.
 */
export const PUBLIC_CAMERA_PACKS: readonly CatalogPack[] = Object.freeze([
  fintrafficPack,
  nswPack,
  tflPack,
  ontarioPack,
  drivebcPack,
  calgaryPack,
  hongKongPack,
  icelandPack,
  queenslandPack,
  trafikverketPack,
]);

/**
 * Frame hosts per pack, for both camera providers — the camera gateway keeps an identical
 * static list (cross-checked by test). Pack ids are unique across the two.
 */
export const PUBLIC_CAMERA_FRAME_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries([...PUBLIC_CAMERA_PACKS, ...UNVERIFIED_CAMERA_PACKS].map((p) => [p.id, p.frameHosts])),
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
  private settings: PublicCamerasSettings = {};
  private readonly packFailures = new Map<string, ProviderErrorInfo>();
  private readonly lastCounts = new Map<string, number>();

  readonly manifest: ProviderManifest;

  constructor(
    private readonly packs: readonly CatalogPack[] = PUBLIC_CAMERA_PACKS,
    manifest: ProviderManifest = PUBLIC_CAMERAS_MANIFEST,
  ) {
    super();
    this.manifest = manifest;
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

  /** Enabled packs whose key is not stored yet (last poll). They are skipped, not failed. */
  readonly waitingForKey = new Set<string>();

  private async runnablePacks(): Promise<CatalogPack[]> {
    const out: CatalogPack[] = [];
    this.waitingForKey.clear();
    for (const pack of this.enabledPacks()) {
      const key = pack.request.credential?.key;
      if (key && !(await this.context.credentials.has(key))) {
        this.waitingForKey.add(pack.id);
        this.packFailures.delete(pack.id);
        continue;
      }
      out.push(pack);
    }
    return out;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    const enabled = await this.runnablePacks();
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

  private async fetchPart(
    pack: CatalogPack,
    part: CatalogPack['request'],
    request: ProviderQuery,
  ): Promise<{ payload: unknown; res: Awaited<ReturnType<ProviderContext['http']['request']>> }> {
    const res = await this.context.http.request({ ...part, signal: request.signal, cacheKey: part.url });
    if (pack.format === 'text') return { payload: res.text(), res };
    try {
      return { payload: res.json(), res };
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${pack.id} catalog is not valid JSON`, { retryable: false });
    }
  }

  private async fetchPack(pack: CatalogPack, request: ProviderQuery): Promise<PackOutcome> {
    let payload: unknown;
    let responses: Array<Awaited<ReturnType<ProviderContext['http']['request']>>>;
    if (!pack.moreRequests?.length) {
      const one = await this.fetchPart(pack, pack.request, request);
      payload = one.payload;
      responses = [one.res];
    } else {
      // Parts in sequence, not at once: they share a host and its rate limit.
      const payloads: unknown[] = [];
      responses = [];
      let firstError: unknown;
      for (const part of [pack.request, ...pack.moreRequests]) {
        try {
          const got = await this.fetchPart(pack, part, request);
          payloads.push(got.payload);
          responses.push(got.res);
        } catch (err) {
          if (err instanceof ProviderError && err.code === 'CANCELLED') throw err;
          firstError ??= err;
          this.context.logger.warn('camera catalogue part failed', {
            pack: pack.id,
            url: part.url,
            code: err instanceof ProviderError ? err.code : 'INTERNAL',
          });
        }
      }
      if (payloads.length === 0) throw firstError;
      payload = payloads;
    }
    const ageMs = Math.max(0, ...responses.map((r) => r.ageMs));
    const res = { stale: responses.some((r) => r.stale), fromCache: responses.every((r) => r.fromCache), ageMs };
    const invalidate = () => responses.forEach((r) => r.invalidate());
    const now = this.context.clock.now();
    const receivedAt = new Date(now).toISOString();
    const observedAt = new Date(now - res.ageMs).toISOString();
    const result = pack.normalize(payload, {
      observedAt,
      origin: res.stale || res.fromCache ? 'cached' : 'live',
      sourceRef: pack.sourceRef ?? pack.request.url,
      hash: (s) => this.context.hash.sha256Hex(s),
    });
    if (result.malformed) {
      invalidate();
      throw new ProviderError('MALFORMED', `${pack.id} catalog has an unexpected shape`, { retryable: false });
    }
    if (result.total > 0 && result.drafts.length === 0) {
      invalidate();
      throw new ProviderError('MALFORMED', `${pack.id} catalog: ${result.total} rows, none valid`, {
        retryable: false,
      });
    }
    // How many cameras each catalogue gave, whenever that changes: the one line in app.log
    // that says a pack is working, not just that it did not fail.
    if (this.lastCounts.get(pack.id) !== result.drafts.length) {
      this.lastCounts.set(pack.id, result.drafts.length);
      this.context.logger.info('camera catalogue', {
        pack: pack.id,
        cameras: result.drafts.length,
        rows: result.total,
        ...(res.stale || res.fromCache ? { cached: true } : {}),
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
    // A pack that needs the operator's own key is not a fault; say it is waiting.
    if (this.waitingForKey.size > 0) {
      const waiting = `${[...this.waitingForKey].join(', ')}: needs an API key (Sources → Credentials)`;
      h.message = h.message ? `${h.message}; ${waiting}` : waiting;
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

/**
 * Camera catalogues whose licence for the images is not confirmed (Caltrans, Austin, New
 * York City, Iowa): the same provider code under its own manifest, off by default and
 * marked for manual review, with a data policy that keeps nothing beyond a day and
 * exports nothing. It exists so the operator can choose to see them; see
 * unverified/manifest.ts.
 */
export function createUnverifiedProvider(): PublicCamerasProvider {
  return new PublicCamerasProvider(UNVERIFIED_CAMERA_PACKS, PUBLIC_CAMERAS_UNVERIFIED_MANIFEST);
}
