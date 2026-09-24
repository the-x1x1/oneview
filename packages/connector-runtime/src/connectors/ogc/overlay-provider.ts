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
 * The host asks `overlays()` right after `start()` — before the first poll has run — so
 * `overlays()` reads the capabilities itself, every time it is asked (the settings it
 * applies may have changed since the last answer); a read already under way is joined
 * rather than repeated, and when the read fails the last good descriptor is the answer.
 * The poll keeps reading them at the definition's interval, for Source Health. Every
 * descriptor is checked against `rasterOverlaySchema` before it leaves the provider, and a
 * document that cannot become one is MALFORMED.
 *
 * The shared read is never tied to one caller's abort signal: an aborted poll stops waiting
 * (CANCELLED) and leaves the read to finish for whoever else joined it. The read is bounded
 * by the definition's request timeout.
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
  protected refresh(): Promise<RasterOverlay> {
    if (this.inflight) return this.inflight;
    const run = (async () => {
      const url = this.capabilitiesUrl();
      const res = await this.context.http.request({
        ...getRequest(this.definition, this.manifest, url, XML_ACCEPT),
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
    const { signal } = request;
    if (signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ProviderError('CANCELLED', 'cancelled while the capabilities were read'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([this.refresh(), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort!);
    }
    return { observations: [] };
  }

  /**
   * The overlays this provider publishes (ADR-008 amendment): the one its definition names,
   * built from a fresh read with the settings as they are now, or the last good one when
   * that read fails.
   */
  async overlays(): Promise<RasterOverlay[]> {
    try {
      return [await this.refresh()];
    } catch (err) {
      if (this.current) return [this.current];
      throw err;
    }
  }

  /** A one-line summary of the published overlay, for Source Health. */
  protected abstract describe(o: RasterOverlay): string;

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (!h.message && this.current) h.message = [this.describe(this.current), ...this.notes].join('; ');
    return h;
  }
}

/** The title, or the fallback when the title is blank, within the contract's 200 characters. */
export function overlayName(title: string | undefined, fallback: string): string {
  const name = title?.trim() || fallback;
  if (name.length <= 200) return name;
  // Cut by code point, so a character outside the BMP is never split into half a surrogate pair.
  let cut = '';
  for (const ch of name) {
    if (cut.length + ch.length > 199) break;
    cut += ch;
  }
  return `${cut}…`;
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
