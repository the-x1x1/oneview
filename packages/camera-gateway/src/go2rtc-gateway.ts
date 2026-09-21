import { isValidLatLon, systemClock, type Clock, type GeoPosition } from '@worldview/world-model';
import { silentLogger, type Logger } from '@worldview/core';
import type { CameraRegistration, CameraSnapshot, CameraSourceInput, CameraStreamDescriptor } from '@worldview/ipc-contract';
import { CameraError, errorForStatus, toCameraError } from './errors.js';
import { assertImage } from './image.js';
import { CameraHealthTracker } from './health.js';
import type { CameraRelay } from './relay.js';
import type { Go2rtcSidecar, FetchLike } from './go2rtc-sidecar.js';
import { LOCAL_CAMERA_PROVIDER_ID } from './direct-gateway.js';
import { cameraIdFor, credentialKeyFor, parseCameraUrl } from './url.js';
import { MAX_FRAME_BYTES, type CameraGateway, type CameraListEntry, type GatewayStatus, type RegisteredCamera, type SecretStore } from './types.js';

export interface Go2rtcGatewayOptions {
  sidecar: Go2rtcSidecar;
  fetch: FetchLike;
  secrets: SecretStore;
  /** When present, HLS output is fronted by the loopback relay (token-protected). */
  relay?: CameraRelay;
  /** Stream flavour handed to the renderer (default 'hls'). */
  streamKind?: 'hls' | 'webrtc';
  clock?: Clock;
  logger?: Logger;
}

/**
 * Go2rtcGateway — RTSP (and anything else go2rtc speaks) through the loopback sidecar.
 * Registration adds the source to go2rtc with `PUT /api/streams`; the credential is
 * re-attached only for that loopback call and is otherwise held in the SecretStore.
 * Snapshots use `/api/frame.jpeg`, streams `/api/stream.m3u8` (HLS) or `/api/webrtc`.
 */
export class Go2rtcGateway implements CameraGateway {
  readonly kind = 'go2rtc' as const;
  private readonly cameras = new Map<string, RegisteredCamera>();
  private readonly synced = new Set<string>();
  private readonly health: CameraHealthTracker;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(private readonly opts: Go2rtcGatewayOptions) {
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
    this.health = new CameraHealthTracker(this.clock);
  }

  async status(): Promise<GatewayStatus> {
    const sidecar = this.opts.sidecar.status();
    const state: GatewayStatus['state'] = sidecar.status === 'running' ? 'ready' : sidecar.status === 'not-configured' ? 'not-configured' : 'unavailable';
    const status: GatewayStatus = { gateway: 'go2rtc', state, cameras: this.cameras.size, sidecar };
    if (sidecar.message) status.message = sidecar.message;
    return status;
  }

  async register(source: CameraSourceInput): Promise<CameraRegistration> {
    // Registering into a sidecar that does not exist would produce a camera that can
    // never be snapshotted or streamed, so the refusal happens here rather than at the
    // first frame. A configured-but-stopped sidecar is different: that registration is
    // held and pushed by syncStreams() when it starts.
    if (!this.opts.sidecar.configured()) {
      throw new CameraError('UNSUPPORTED_SCHEME', 'RTSP sources need the go2rtc sidecar (not configured); see docs/operator/cameras.md');
    }
    const name = typeof source.name === 'string' ? source.name.trim().slice(0, 120) : '';
    if (!name) throw new CameraError('INVALID_URL', 'camera name is required');
    const parsed = parseCameraUrl(source.url, ['rtsp', 'rtsps', 'http', 'https']);
    const cameraId = cameraIdFor(parsed.url);
    const objectId = `camera:${LOCAL_CAMERA_PROVIDER_ID}:${cameraId}`;
    const previous = this.cameras.get(cameraId);
    const record: RegisteredCamera = { cameraId, objectId, name, url: parsed.url, kind: parsed.kind, registeredAt: previous?.registeredAt ?? new Date(this.clock.now()).toISOString() };
    if (parsed.credential) {
      record.credentialKey = credentialKeyFor(cameraId);
      await this.opts.secrets.set(record.credentialKey, `${parsed.credential.username}:${parsed.credential.password}`);
    } else if (previous?.credentialKey) {
      await this.opts.secrets.delete(previous.credentialKey);
    }
    if (source.position && isValidLatLon(source.position.latitude, source.position.longitude)) record.position = { latitude: source.position.latitude, longitude: source.position.longitude } satisfies GeoPosition;
    if (typeof source.headingDegrees === 'number' && Number.isFinite(source.headingDegrees)) record.headingDegrees = ((source.headingDegrees % 360) + 360) % 360;
    this.cameras.set(cameraId, record);
    this.synced.delete(cameraId);
    if (this.opts.sidecar.isRunning()) await this.pushStream(record);
    this.logger.info('camera registered (go2rtc)', { cameraId, kind: record.kind, credential: record.credentialKey !== undefined });
    return { cameraId, objectId, gateway: 'go2rtc' };
  }

  /** Re-send every registration to the sidecar (after it (re)starts). Streams live in go2rtc memory only. */
  async syncStreams(): Promise<void> {
    if (!this.opts.sidecar.isRunning()) return;
    for (const record of this.cameras.values()) {
      if (this.synced.has(record.cameraId)) continue;
      try { await this.pushStream(record); } catch (err) { this.logger.warn('go2rtc stream sync failed', { cameraId: record.cameraId, code: toCameraError(err).code }); }
    }
  }

  async snapshot(cameraId: string): Promise<CameraSnapshot> {
    const camera = this.get(cameraId);
    try {
      this.assertRunning();
      if (!this.synced.has(cameraId)) await this.pushStream(camera);
      const res = await this.opts.fetch(`${this.opts.sidecar.apiBase()}/api/frame.jpeg?src=${encodeURIComponent(cameraId)}`, { method: 'GET', signal: AbortSignal.timeout(10_000) });
      const bad = errorForStatus(res.status);
      if (bad) throw bad;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_FRAME_BYTES) throw new CameraError('TOO_LARGE', 'frame exceeds size cap', { retryable: false });
      const mimeType = assertImage(buf);
      this.health.success(cameraId);
      return { cameraId, capturedAt: new Date(this.clock.now()).toISOString(), mimeType, bytes: buf };
    } catch (err) {
      const ce = toCameraError(err);
      if (ce.code !== 'CANCELLED') this.health.failure(cameraId, ce);
      this.logger.warn('go2rtc snapshot failed', { cameraId, code: ce.code });
      throw ce;
    }
  }

  async stream(cameraId: string): Promise<CameraStreamDescriptor> {
    const camera = this.get(cameraId);
    this.assertRunning();
    if (!this.synced.has(cameraId)) await this.pushStream(camera);
    const api = this.opts.sidecar.apiBase();
    if ((this.opts.streamKind ?? 'hls') === 'webrtc') return { cameraId, kind: 'webrtc', url: `${api}/api/webrtc?src=${encodeURIComponent(cameraId)}` };
    const upstream = `${api}/api/stream.m3u8?src=${encodeURIComponent(cameraId)}`;
    const relay = this.opts.relay;
    if (relay && relay.isListening()) {
      if (!relay.has(cameraId)) relay.add({ cameraId, url: upstream, kind: 'hls', headers: async () => ({}) });
      const url = relay.urlFor(cameraId);
      if (url) return { cameraId, kind: 'hls', url };
    }
    return { cameraId, kind: 'hls', url: upstream };
  }

  async unregister(cameraId: string): Promise<void> {
    const camera = this.cameras.get(cameraId);
    if (!camera) return;
    this.cameras.delete(cameraId);
    this.synced.delete(cameraId);
    this.health.remove(cameraId);
    this.opts.relay?.remove(cameraId);
    if (camera.credentialKey) await this.opts.secrets.delete(camera.credentialKey);
    if (this.opts.sidecar.isRunning()) {
      try { await this.opts.fetch(`${this.opts.sidecar.apiBase()}/api/streams?src=${encodeURIComponent(cameraId)}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }); }
      catch (err) { this.logger.warn('go2rtc stream removal failed', { cameraId, code: toCameraError(err).code }); }
    }
  }

  async list(): Promise<CameraListEntry[]> {
    return [...this.cameras.values()].map((c) => {
      const e: CameraListEntry = { cameraId: c.cameraId, name: c.name, objectId: c.objectId, gateway: 'go2rtc', kind: c.kind, health: this.health.get(c.cameraId) };
      if (c.position) e.position = c.position;
      if (c.headingDegrees !== undefined) e.headingDegrees = c.headingDegrees;
      return e;
    });
  }

  export(): RegisteredCamera[] { return [...this.cameras.values()].map((c) => ({ ...c })); }

  restore(records: RegisteredCamera[]): void {
    for (const r of records) {
      if (!/^[0-9a-f]{12}$/.test(r.cameraId)) continue;
      try { parseCameraUrl(r.url, ['rtsp', 'rtsps', 'http', 'https']); } catch { continue; }
      this.cameras.set(r.cameraId, { ...r });
    }
  }

  private get(cameraId: string): RegisteredCamera {
    const c = this.cameras.get(cameraId);
    if (!c) throw new CameraError('NOT_FOUND', `camera ${cameraId} is not registered`);
    return c;
  }

  private assertRunning(): void {
    if (!this.opts.sidecar.isRunning()) throw new CameraError('UNAVAILABLE', 'go2rtc sidecar is not running');
  }

  /** `PUT /api/streams?name=<id>&src=<url>` — the only place a credential is re-attached, for a loopback call. */
  private async pushStream(record: RegisteredCamera): Promise<void> {
    const src = await this.sourceWithCredential(record);
    const url = `${this.opts.sidecar.apiBase()}/api/streams?name=${encodeURIComponent(record.cameraId)}&src=${encodeURIComponent(src)}`;
    const res = await this.opts.fetch(url, { method: 'PUT', signal: AbortSignal.timeout(5000) });
    if (res.status < 200 || res.status >= 300) throw new CameraError('UPSTREAM_ERROR', `go2rtc refused the stream (HTTP ${res.status})`, { httpStatus: res.status, retryable: false });
    this.synced.add(record.cameraId);
  }

  private async sourceWithCredential(record: RegisteredCamera): Promise<string> {
    if (!record.credentialKey) return record.url;
    const secret = await this.opts.secrets.get(record.credentialKey);
    if (!secret) return record.url;
    const sep = secret.indexOf(':');
    const u = new URL(record.url);
    u.username = encodeURIComponent(sep >= 0 ? secret.slice(0, sep) : secret);
    u.password = encodeURIComponent(sep >= 0 ? secret.slice(sep + 1) : '');
    return u.toString();
  }
}
