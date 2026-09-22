import type { GeoPosition } from '@worldview/world-model';
import type {
  CameraRegistration,
  CameraSnapshot,
  CameraSourceInput,
  CameraStreamDescriptor,
} from '@worldview/ipc-contract';

/**
 * CameraGateway — the interface behind `camera.*` IPC channels (ADR-009, directive §71).
 *
 * Two implementations: `DirectGateway` (http(s) MJPEG / HLS / JPEG-snapshot sources,
 * fetched by the main process from server-registered URLs only) and `Go2rtcGateway`
 * (optional loopback sidecar for RTSP and other protocols). MediaMTX can implement
 * the same interface later.
 *
 * Invariants shared by every implementation:
 *  - credentials never leave the main process: URL credentials are moved to the
 *    injected `SecretStore` at registration and re-attached per request;
 *  - the renderer only ever receives loopback URLs carrying a per-camera token;
 *  - nothing fetches a URL that was not registered first;
 *  - frames are returned to the caller and forgotten — no retention, no analysis.
 */
export interface CameraGateway {
  readonly kind: GatewayKind;
  status(): Promise<GatewayStatus>;
  register(source: CameraSourceInput): Promise<CameraRegistration>;
  snapshot(cameraId: string): Promise<CameraSnapshot>;
  stream(cameraId: string): Promise<CameraStreamDescriptor>;
  unregister(cameraId: string): Promise<void>;
  list(): Promise<CameraListEntry[]>;
}

export type GatewayKind = 'direct' | 'go2rtc';

/** How a registered source is consumed. Inferred from the URL at registration. */
export type CameraSourceKind = 'mjpeg' | 'hls' | 'snapshot' | 'rtsp';

export interface GatewayStatus {
  gateway: GatewayKind;
  state: 'ready' | 'degraded' | 'unavailable' | 'not-configured';
  cameras: number;
  message?: string;
  relay?: { listening: boolean; port?: number; activeStreams: number };
  sidecar?: SidecarStatus;
}

/** Shape matches `DiagnosticsSnapshot.sidecars[]` in the IPC contract. */
export interface SidecarStatus {
  id: string;
  status: 'not-configured' | 'stopped' | 'running' | 'error';
  version?: string;
  message?: string;
}

export interface CameraHealth {
  status: 'unknown' | 'ok' | 'degraded' | 'unavailable';
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: { code: string; message: string; httpStatus?: number };
}

export interface CameraListEntry {
  cameraId: string;
  name: string;
  objectId: string;
  gateway: GatewayKind;
  kind: CameraSourceKind;
  position?: GeoPosition;
  headingDegrees?: number;
  health: CameraHealth;
}

/** Persisted registration record. Never contains a secret — only the secret key. */
export interface RegisteredCamera {
  cameraId: string;
  objectId: string;
  name: string;
  /** Normalized URL with any credentials removed. */
  url: string;
  kind: CameraSourceKind;
  /** Key in the SecretStore holding `user:password` for this camera, when the URL carried one. */
  credentialKey?: string;
  position?: GeoPosition;
  headingDegrees?: number;
  registeredAt: string;
}

/** Secure storage for camera credentials (Electron safeStorage in production, memory in tests). */
export interface SecretStore {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
}

export interface FetchBytesOptions {
  maxBytes: number;
  timeoutMs: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface FetchBytesResult {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

/** Bounded single-shot fetch. Implementations must not follow redirects and must cap the body at `maxBytes`. */
export type ByteFetcher = (url: string, opts: FetchBytesOptions) => Promise<FetchBytesResult>;

export interface UpstreamStream {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  /** Abort the upstream connection (client went away). */
  cancel(): void;
}

/** Opens a streaming upstream connection (MJPEG, HLS segments). Redirects are never followed. */
export type UpstreamOpener = (
  url: string,
  opts: { headers?: Record<string, string>; signal: AbortSignal; timeoutMs: number },
) => Promise<UpstreamStream>;

export const CAMERA_USER_AGENT = 'WorldView/0.1 camera-gateway (+https://github.com/the-x1x1/oneview)';

/** Hard cap for a single still frame (directive: 8 MiB). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FRAME_TIMEOUT_MS = 10_000;
