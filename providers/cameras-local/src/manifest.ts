import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * cameras-local — cameras the user registered through the camera gateway
 * (`camera.register`). The provider reads the registered list from its settings and
 * publishes one `camera` object per entry; URLs and credentials never appear here —
 * they live in the gateway / safeStorage, and media refs `camera:<cameraId>` are
 * resolved by the gateway at display time. No network: works offline.
 *
 * Data policy equals the registry record `cameras-local`: a user's private camera
 * list is never redistributed or packed; export of the user's own list is allowed.
 */
export const CAMERAS_LOCAL_MANIFEST: ProviderManifest = {
  id: 'cameras-local',
  name: 'Local cameras',
  version: '0.1.0',
  description: 'Cameras you added yourself (MJPEG, HLS, still-image or, with the go2rtc sidecar, RTSP). Placed on the map at the position you gave; frames are shown as the camera serves them, never stored.',
  objectTypes: ['camera'],
  categories: ['cameras'],
  transport: 'local-process',
  capabilities: { live: true, historical: false, offline: true, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 30_000,
    minIntervalMs: 5_000,
    timeoutMs: 5_000,
    maxRetries: 0,
    maxRequestsPerMinute: 0,
    staleWhileErrorMs: 0,
    freshness: { camera: { liveSeconds: 300, recentSeconds: 3600 } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: true,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: false,
    attributionText: 'User-configured cameras',
  },
  attribution: { text: 'User-configured cameras' },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: ['127.0.0.1'],
};
