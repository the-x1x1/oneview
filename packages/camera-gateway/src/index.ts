/**
 * @worldview/camera-gateway — ADR-009.
 *
 * `CameraGateway` (status/register/snapshot/stream/unregister/list) with two
 * implementations: `DirectGateway` (http(s) MJPEG / HLS / still cameras behind the
 * loopback `CameraRelay`) and `Go2rtcGateway` (optional loopback sidecar for RTSP).
 * `CameraHub` composes them with the `PublicFrameRegistry` (allowlisted public-camera
 * frames) behind the `camera.*` IPC channels. No discovery scanning, no recognition,
 * no frame retention.
 */
export * from './types.js';
export * from './errors.js';
export {
  parseCameraUrl,
  cameraIdFor,
  isCameraId,
  inferKind,
  credentialKeyFor,
  basicAuthHeader,
  CAMERA_ID_PATTERN,
  type ParsedCameraUrl,
} from './url.js';
export { detectImageType, assertImage, firstJpegFrame, type FrameMimeType } from './image.js';
export { MemorySecretStore } from './secret-store.js';
export { CameraHealthTracker } from './health.js';
export { CameraRelay, type CameraRelayOptions, type RelayCamera } from './relay.js';
export {
  hlsBaseFor,
  rewritePlaylist,
  containedRelativePath,
  resolveContained,
  looksLikePlaylist,
  type HlsBase,
} from './hls.js';
export { DirectGateway, LOCAL_CAMERA_PROVIDER_ID, type DirectGatewayOptions } from './direct-gateway.js';
export {
  Go2rtcSidecar,
  GO2RTC_PINNED_VERSION,
  GO2RTC_API_PORT,
  GO2RTC_RTSP_PORT,
  GO2RTC_CONFIG_FILE,
  type Go2rtcSidecarOptions,
  type SpawnFn,
  type SpawnedProcess,
  type FetchLike,
} from './go2rtc-sidecar.js';
export { Go2rtcGateway, type Go2rtcGatewayOptions } from './go2rtc-gateway.js';
export {
  PublicFrameRegistry,
  PUBLIC_FRAME_HOSTS,
  PUBLIC_MEDIA_REF,
  publicCameraFromObject,
  isAllowedFrameUrl,
  type PublicCamera,
  type PublicFrameRegistryOptions,
} from './public-frames.js';
export { CameraHub, type CameraHubOptions, type CameraHubStatus } from './hub.js';
export { createFetchByteFetcher, createFetchUpstreamOpener } from './fetch-adapters.js';
export * as testing from './testing.js';
