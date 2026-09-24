import { rasterOverlaySchema, type JsonValue, type Observation, type RasterOverlay } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import type { ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { XML_ACCEPT, getRequest } from './common.js';

/**
 * What the `wms` and `wmts` providers share: they publish one raster overlay (ADR-008
 * amendment 2026-09-23, `RasterOverlay` in the world model) built from the service's
 * capabilities, and produce no observations.
 *
 * The host asks `overlays()` once, right after `start()` — before the first poll has run —
 * so `overlays()` reads the capabilities itself when no poll has yet; a poll that is
 * already reading them is joined rather than repeated. The poll keeps reading them at the
 * definition's interval, for Source Health and so that the next `overlays()` answers from
 * what the service says now. Every descriptor is checked against `rasterOverlaySchema`
 * before it leaves the provider, and a document that cannot become one is MALFORMED.
 */
export abstract class OgcOverlayProvider extends PollingProvider {
  abstract override readonly manifest: ProviderManifest;
  protected current: RasterOverlay | undefined;
  protected notes: string[] = [];
  private inflight: Promise<RasterOverlay> | undefined;

  constructor(readonly definition: ConnectorProviderDefinition) {
    super();
  }

  protected override async onInitialize(_context: ProviderContext): Promise<void> {
    /* the capabilities are read by the first poll or the first overlays(), whichever comes first */
  }

  /** The URL of the capabilities document. */
  abstract capabilitiesUrl(): string;

  /** The descriptor for this definition from a capabilities document; throws MALFORMED when there is none. */
  abstract buildOverlay(capabilities: string, settings: Record<string, JsonValue>): RasterOverlay;

  /** Read the capabilities and build the descriptor; callers at the same time share one request. */
  protected refresh(signal?: AbortSignal): Promise<RasterOverlay> {
    if (this.inflight) return this.inflight;
    const run = (async () => {
      const url = this.capabilitiesUrl();
      const res = await this.context.http.request({
        ...getRequest(this.definition, this.manifest, url, XML_ACCEPT),
        ...(signal ? { signal } : {}),
        cacheKey: url,
      });
      const settings = await this.context.settings.get();
      let built: RasterOverlay;
      try {
        built = this.buildOverlay(res.text(), settings);
      } catch (err) {
        res.invalidate();
        throw err;
      }
      const checked = rasterOverlaySchema.parse(built);
      if (!checked.ok) {
        res.invalidate();
        const issue = checked.issues[0];
        throw new ProviderError(
          'MALFORMED',
          `${this.definition.id}: the overlay does not meet the contract (${issue?.path || '$'}: ${issue?.message ?? 'invalid'})`,
          { retryable: false },
        );
      }
      this.current = checked.value;
      return checked.value;
    })();
    this.inflight = run;
    const clear = () => {
      if (this.inflight === run) this.inflight = undefined;
    };
    run.then(clear, clear);
    return run;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    await this.refresh(request.signal);
    return { observations: [] };
  }

  /** The overlays this provider publishes (ADR-003 amendment): the one its definition names. */
  async overlays(): Promise<RasterOverlay[]> {
    return [this.current ?? (await this.refresh())];
  }

  /** A one-line summary of the published overlay, for Source Health. */
  protected abstract describe(o: RasterOverlay): string;

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (!h.message && this.current) h.message = [this.describe(this.current), ...this.notes].join('; ');
    return h;
  }
}

const OVERLAY_ID_PART = /[^a-z0-9._:-]+/g;

/** `<definition id>:<layer>`, in the characters an overlay id allows (the contract's convention). */
export function overlayIdFor(definitionId: string, layer: string): string {
  const part =
    layer
      .toLowerCase()
      .replace(OVERLAY_ID_PART, '-')
      .replace(/^-+|-+$/g, '') || 'layer';
  return `${definitionId}:${part}`.slice(0, 128);
}
