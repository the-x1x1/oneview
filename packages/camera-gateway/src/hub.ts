import { systemClock, type Clock } from '@worldview/world-model';
import { silentLogger, type Logger } from '@worldview/core';
import type {
  CameraRegistration,
  CameraSnapshot,
  CameraSourceInput,
  CameraStreamDescriptor,
} from '@worldview/ipc-contract';
import { CameraError, errorForStatus, toCameraError } from './errors.js';
import { assertImage } from './image.js';
import { CameraHealthTracker } from './health.js';
import type { DirectGateway } from './direct-gateway.js';
import type { Go2rtcGateway } from './go2rtc-gateway.js';
import type { CameraRelay } from './relay.js';
import { PUBLIC_MEDIA_REF, type PublicFrameRegistry } from './public-frames.js';
import { cameraIdFor, isCameraId } from './url.js';
import {
  CAMERA_USER_AGENT,
  DEFAULT_FRAME_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  type ByteFetcher,
  type CameraGateway,
  type CameraListEntry,
  type GatewayStatus,
} from './types.js';

export interface CameraHubOptions {
  direct: DirectGateway;
  go2rtc?: Go2rtcGateway;
  publicFrames: PublicFrameRegistry;
  fetchBytes: ByteFetcher;
  relay?: CameraRelay;
  clock?: Clock;
  logger?: Logger;
  userAgent?: string;
  frameTimeoutMs?: number;
}

export interface CameraHubStatus {
  direct: GatewayStatus;
  go2rtc?: GatewayStatus;
  publicCameras: number;
}

/**
 * CameraHub — what the runtime's `camera.*` handlers call. It routes:
 *  - `register()` by URL scheme: rtsp(s) → go2rtc (or a typed error when the sidecar is
 *    not configured), http(s) → direct;
 *  - `snapshot()` / `stream()` by id shape: a 12-hex camera id → the gateway that
 *    registered it; a `public:<pack>:<cameraId>` media ref → the public-frame allowlist.
 * Public frames are fetched with WORLDVIEW's own User-Agent. If a host refuses that
 * (or answers with a non-image placeholder) the frame is reported unavailable — the
 * gateway never impersonates a browser.
 */
export class CameraHub {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly publicHealth: CameraHealthTracker;
  private readonly userAgent: string;

  constructor(private readonly opts: CameraHubOptions) {
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
    this.publicHealth = new CameraHealthTracker(this.clock);
    this.userAgent = opts.userAgent ?? CAMERA_USER_AGENT;
  }

  async status(): Promise<CameraHubStatus> {
    const status: CameraHubStatus = {
      direct: await this.opts.direct.status(),
      publicCameras: this.opts.publicFrames.size(),
    };
    if (this.opts.go2rtc) status.go2rtc = await this.opts.go2rtc.status();
    return status;
  }

  gatewayFor(source: CameraSourceInput): CameraGateway {
    const scheme = (typeof source.url === 'string' ? (source.url.trim().split(':')[0] ?? '') : '').toLowerCase();
    if (scheme === 'rtsp' || scheme === 'rtsps') {
      if (!this.opts.go2rtc)
        throw new CameraError(
          'UNSUPPORTED_SCHEME',
          'RTSP sources need the go2rtc sidecar (not configured); see docs/operator/cameras.md',
        );
      return this.opts.go2rtc;
    }
    return this.opts.direct;
  }

  async register(source: CameraSourceInput): Promise<CameraRegistration> {
    return this.gatewayFor(source).register(source);
  }

  async snapshot(idOrRef: string): Promise<CameraSnapshot> {
    if (PUBLIC_MEDIA_REF.test(idOrRef)) return this.publicSnapshot(idOrRef);
    return (await this.ownerOf(idOrRef)).snapshot(idOrRef);
  }

  async stream(idOrRef: string): Promise<CameraStreamDescriptor> {
    if (PUBLIC_MEDIA_REF.test(idOrRef)) return this.publicStream(idOrRef);
    return (await this.ownerOf(idOrRef)).stream(idOrRef);
  }

  async unregister(cameraId: string): Promise<void> {
    if (!isCameraId(cameraId)) throw new CameraError('NOT_FOUND', 'unknown camera id');
    await this.opts.direct.unregister(cameraId);
    await this.opts.go2rtc?.unregister(cameraId);
  }

  async list(): Promise<CameraListEntry[]> {
    const out = await this.opts.direct.list();
    if (this.opts.go2rtc) out.push(...(await this.opts.go2rtc.list()));
    return out;
  }

  private async ownerOf(cameraId: string): Promise<CameraGateway> {
    if (!isCameraId(cameraId)) throw new CameraError('NOT_FOUND', 'unknown camera id');
    const direct = await this.opts.direct.list();
    if (direct.some((c) => c.cameraId === cameraId)) return this.opts.direct;
    if (this.opts.go2rtc && (await this.opts.go2rtc.list()).some((c) => c.cameraId === cameraId))
      return this.opts.go2rtc;
    throw new CameraError('NOT_FOUND', `camera ${cameraId} is not registered`);
  }

  private async publicSnapshot(ref: string): Promise<CameraSnapshot> {
    const cam = this.opts.publicFrames.get(ref);
    if (!cam) throw new CameraError('NOT_FOUND', 'public camera frame is not registered');
    try {
      const fetchOnce = (url: string) =>
        this.opts.fetchBytes(url, {
          maxBytes: MAX_FRAME_BYTES,
          timeoutMs: this.opts.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
          headers: { 'User-Agent': this.userAgent, Accept: 'image/jpeg,image/png' },
        });
      let r = await fetchOnce(cam.frameUrl);
      // Some image hosts answer a camera's stable URL with a redirect to the current frame
      // (Hong Kong's asks clients to follow 301/302). Up to two hops are followed, and only
      // to a URL the same pack may serve frames from; anything else stays a refusal.
      for (let hop = 0; hop < 2 && r.status >= 300 && r.status < 400; hop++) {
        const location = r.headers['location'];
        const next = location ? safeResolve(location, cam.frameUrl) : undefined;
        if (!next || !this.opts.publicFrames.allowsFrameUrl(cam.pack, next)) break;
        r = await fetchOnce(next);
      }
      const bad = errorForStatus(r.status);
      if (bad) throw bad;
      const mimeType = assertImage(r.bytes);
      this.publicHealth.success(ref);
      const now = this.clock.now();
      const upstream = imageTime(r.headers['last-modified'], now);
      return {
        cameraId: ref,
        capturedAt: new Date(upstream ?? now).toISOString(),
        capturedAtSource: upstream !== undefined ? 'upstream' : 'fetched',
        mimeType,
        bytes: r.bytes,
      };
    } catch (err) {
      const ce = toCameraError(err);
      if (ce.code !== 'CANCELLED') this.publicHealth.failure(ref, ce);
      this.logger.warn('public frame unavailable', {
        ref,
        pack: cam.pack,
        code: ce.code,
        ...(ce.httpStatus !== undefined ? { upstreamStatus: ce.httpStatus } : {}),
      });
      throw ce;
    }
  }

  private async publicStream(ref: string): Promise<CameraStreamDescriptor> {
    const cam = this.opts.publicFrames.get(ref);
    if (!cam) throw new CameraError('NOT_FOUND', 'public camera frame is not registered');
    const relay = this.opts.relay;
    if (!relay || !relay.isListening()) throw new CameraError('UNAVAILABLE', 'camera relay is not running');
    const relayId = cameraIdFor(ref);
    if (!relay.has(relayId))
      relay.add({
        cameraId: relayId,
        url: cam.frameUrl,
        kind: 'snapshot',
        headers: async () => ({ 'User-Agent': this.userAgent }),
      });
    const url = relay.urlFor(relayId);
    if (!url) throw new CameraError('UNAVAILABLE', 'camera relay has no route for this camera');
    return { cameraId: ref, kind: 'snapshot-poll', url };
  }

  publicFrameHealth(ref: string): ReturnType<CameraHealthTracker['get']> {
    return this.publicHealth.get(ref);
  }
}

/**
 * The image's own time from its Last-Modified header. A public frame is a still that the
 * agency replaces every minute to ten; saying it was "captured" when we fetched it would
 * make a ten-minute-old picture look live. A header that is missing, unparsable, more
 * than a week old or more than five minutes in the future is not believed.
 */
export function imageTime(lastModified: string | undefined, now: number): number | undefined {
  if (!lastModified) return undefined;
  const t = Date.parse(lastModified);
  if (!Number.isFinite(t)) return undefined;
  if (t > now + 5 * 60_000 || t < now - 7 * 24 * 3600_000) return undefined;
  return Math.min(t, now);
}

function safeResolve(location: string, base: string): string | undefined {
  try {
    return new URL(location, base).toString();
  } catch {
    return undefined;
  }
}
