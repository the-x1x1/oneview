import { isValidLatLon, systemClock, type Clock, type GeoPosition } from '@worldview/world-model';
import { silentLogger, type Logger } from '@worldview/core';
import type { CameraRegistration, CameraSnapshot, CameraSourceInput, CameraStreamDescriptor } from '@worldview/ipc-contract';
import { CameraError, errorForStatus, toCameraError } from './errors.js';
import { assertImage, firstJpegFrame } from './image.js';
import { CameraHealthTracker } from './health.js';
import type { CameraRelay } from './relay.js';
import { basicAuthHeader, cameraIdFor, credentialKeyFor, parseCameraUrl } from './url.js';
import {
  CAMERA_USER_AGENT, DEFAULT_FRAME_TIMEOUT_MS, MAX_FRAME_BYTES,
  type ByteFetcher, type CameraGateway, type CameraListEntry, type GatewayStatus, type RegisteredCamera, type SecretStore, type UpstreamOpener,
} from './types.js';

export const LOCAL_CAMERA_PROVIDER_ID = 'cameras-local';

export interface DirectGatewayOptions {
  fetchBytes: ByteFetcher;
  /** Needed for MJPEG snapshots (first frame of the stream). Optional. */
  openUpstream?: UpstreamOpener;
  secrets: SecretStore;
  /** Loopback relay for `stream()`. Without it only `snapshot()` works. */
  relay?: CameraRelay;
  clock?: Clock;
  logger?: Logger;
  frameTimeoutMs?: number;
  userAgent?: string;
}

/**
 * DirectGateway — http(s) MJPEG / HLS / still-image cameras, fetched by the main
 * process. Registration validates and normalizes the URL, moves embedded
 * credentials into the SecretStore, and derives a deterministic camera id from
 * the credential-free URL. The stored record never contains a secret.
 */
export class DirectGateway implements CameraGateway {
  readonly kind = 'direct' as const;
  private readonly cameras = new Map<string, RegisteredCamera>();
  private readonly health: CameraHealthTracker;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(private readonly opts: DirectGatewayOptions) {
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
    this.health = new CameraHealthTracker(this.clock);
    this.timeoutMs = opts.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
    this.userAgent = opts.userAgent ?? CAMERA_USER_AGENT;
  }

  async status(): Promise<GatewayStatus> {
    const relay = this.opts.relay;
    const counts = this.health.counts(this.cameras.keys());
    const status: GatewayStatus = { gateway: 'direct', state: 'ready', cameras: this.cameras.size };
    if (relay) {
      status.relay = { listening: relay.isListening(), activeStreams: relay.activeStreams(), ...(relay.port() !== undefined ? { port: relay.port()! } : {}) };
      if (!relay.isListening()) { status.state = 'degraded'; status.message = 'relay not listening; streams unavailable'; }
    } else {
      status.message = 'no relay configured; snapshots only';
    }
    if (status.state === 'ready' && this.cameras.size > 0 && counts.unavailable === this.cameras.size) { status.state = 'degraded'; status.message = 'all cameras unavailable'; }
    return status;
  }

  async register(source: CameraSourceInput): Promise<CameraRegistration> {
    const name = typeof source.name === 'string' ? source.name.trim().slice(0, 120) : '';
    if (!name) throw new CameraError('INVALID_URL', 'camera name is required');
    const parsed = parseCameraUrl(source.url, ['http', 'https']);
    const cameraId = cameraIdFor(parsed.url);
    const objectId = `camera:${LOCAL_CAMERA_PROVIDER_ID}:${cameraId}`;
    const previous = this.cameras.get(cameraId);

    const record: RegisteredCamera = { cameraId, objectId, name, url: parsed.url, kind: parsed.kind, registeredAt: previous?.registeredAt ?? new Date(this.clock.now()).toISOString() };
    if (parsed.credential) {
      const key = credentialKeyFor(cameraId);
      await this.opts.secrets.set(key, `${parsed.credential.username}:${parsed.credential.password}`);
      record.credentialKey = key;
    } else if (previous?.credentialKey) {
      await this.opts.secrets.delete(previous.credentialKey);
    }
    const position = validPosition(source.position);
    if (position) record.position = position;
    const heading = normalizeHeading(source.headingDegrees);
    if (heading !== undefined) record.headingDegrees = heading;

    this.cameras.set(cameraId, record);
    this.attachRelay(record);
    this.logger.info('camera registered', { cameraId, kind: record.kind, credential: record.credentialKey !== undefined });
    return { cameraId, objectId, gateway: 'direct' };
  }

  async snapshot(cameraId: string): Promise<CameraSnapshot> {
    const camera = this.get(cameraId);
    try {
      const bytes = await this.fetchFrame(camera);
      const mimeType = assertImage(bytes);
      this.health.success(cameraId);
      return { cameraId, capturedAt: new Date(this.clock.now()).toISOString(), mimeType, bytes };
    } catch (err) {
      const ce = toCameraError(err);
      if (ce.code !== 'CANCELLED') this.health.failure(cameraId, ce);
      this.logger.warn('camera snapshot failed', { cameraId, code: ce.code, ...(ce.httpStatus !== undefined ? { upstreamStatus: ce.httpStatus } : {}) });
      throw ce;
    }
  }

  async stream(cameraId: string): Promise<CameraStreamDescriptor> {
    const camera = this.get(cameraId);
    const relay = this.opts.relay;
    if (!relay || !relay.isListening()) throw new CameraError('UNAVAILABLE', 'camera relay is not running');
    if (!relay.has(cameraId)) this.attachRelay(camera);
    const url = relay.urlFor(cameraId);
    if (!url) throw new CameraError('UNAVAILABLE', 'camera relay has no route for this camera');
    const kind = camera.kind === 'mjpeg' ? 'mjpeg' : camera.kind === 'hls' ? 'hls' : 'snapshot-poll';
    return { cameraId, kind, url };
  }

  async unregister(cameraId: string): Promise<void> {
    const camera = this.cameras.get(cameraId);
    if (!camera) return;
    this.cameras.delete(cameraId);
    this.health.remove(cameraId);
    this.opts.relay?.remove(cameraId);
    if (camera.credentialKey) await this.opts.secrets.delete(camera.credentialKey);
    this.logger.info('camera unregistered', { cameraId });
  }

  async list(): Promise<CameraListEntry[]> {
    return [...this.cameras.values()].map((c) => this.entryFor(c));
  }

  /** Persistence hooks for the runtime: records without secrets in, same out. */
  export(): RegisteredCamera[] { return [...this.cameras.values()].map((c) => ({ ...c })); }

  restore(records: RegisteredCamera[]): void {
    for (const r of records) {
      if (!/^[0-9a-f]{12}$/.test(r.cameraId)) continue;
      try { parseCameraUrl(r.url, ['http', 'https']); } catch { continue; }
      const record: RegisteredCamera = { ...r };
      this.cameras.set(r.cameraId, record);
      this.attachRelay(record);
    }
  }

  private get(cameraId: string): RegisteredCamera {
    const c = this.cameras.get(cameraId);
    if (!c) throw new CameraError('NOT_FOUND', `camera ${cameraId} is not registered`);
    return c;
  }

  private entryFor(c: RegisteredCamera): CameraListEntry {
    const e: CameraListEntry = { cameraId: c.cameraId, name: c.name, objectId: c.objectId, gateway: 'direct', kind: c.kind, health: this.health.get(c.cameraId) };
    if (c.position) e.position = c.position;
    if (c.headingDegrees !== undefined) e.headingDegrees = c.headingDegrees;
    return e;
  }

  private attachRelay(record: RegisteredCamera): void {
    const relay = this.opts.relay;
    if (!relay || record.kind === 'rtsp') return;
    relay.add({ cameraId: record.cameraId, url: record.url, kind: record.kind, headers: () => this.headersFor(record.cameraId) });
  }

  private async headersFor(cameraId: string): Promise<Record<string, string>> {
    const camera = this.cameras.get(cameraId);
    const headers: Record<string, string> = { 'User-Agent': this.userAgent };
    if (camera?.credentialKey) {
      const secret = await this.opts.secrets.get(camera.credentialKey);
      if (secret) headers['Authorization'] = basicAuthHeader(secret);
    }
    return headers;
  }

  private async fetchFrame(camera: RegisteredCamera): Promise<Uint8Array> {
    const headers = await this.headersFor(camera.cameraId);
    switch (camera.kind) {
      case 'snapshot': {
        const r = await this.opts.fetchBytes(camera.url, { maxBytes: MAX_FRAME_BYTES, timeoutMs: this.timeoutMs, headers: { Accept: 'image/jpeg,image/png', ...headers } });
        const bad = errorForStatus(r.status);
        if (bad) throw bad;
        return r.bytes;
      }
      case 'mjpeg': {
        if (!this.opts.openUpstream) throw new CameraError('UNSUPPORTED', 'MJPEG snapshots need a streaming upstream opener', { retryable: false });
        const abort = new AbortController();
        const upstream = await this.opts.openUpstream(camera.url, { headers, signal: abort.signal, timeoutMs: this.timeoutMs });
        const bad = errorForStatus(upstream.status);
        if (bad) { upstream.cancel(); throw bad; }
        try { return await firstJpegFrame(upstream.body, MAX_FRAME_BYTES); } finally { abort.abort(); upstream.cancel(); }
      }
      case 'hls': throw new CameraError('UNSUPPORTED', 'HLS sources have no still frame; use stream()', { retryable: false });
      default: throw new CameraError('UNSUPPORTED', `${camera.kind} sources are not served by the direct gateway`, { retryable: false });
    }
  }
}

function validPosition(p: GeoPosition | undefined): GeoPosition | undefined {
  if (!p || !isValidLatLon(p.latitude, p.longitude)) return undefined;
  const out: GeoPosition = { latitude: p.latitude, longitude: p.longitude };
  if (typeof p.altitudeM === 'number' && Number.isFinite(p.altitudeM)) { out.altitudeM = p.altitudeM; if (p.altitudeDatum) out.altitudeDatum = p.altitudeDatum; }
  return out;
}

function normalizeHeading(h: number | undefined): number | undefined {
  if (typeof h !== 'number' || !Number.isFinite(h)) return undefined;
  return ((h % 360) + 360) % 360;
}
