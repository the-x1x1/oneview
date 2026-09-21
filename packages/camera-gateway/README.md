# @worldview/camera-gateway

Implements ADR-009. Everything camera-related that the main process does: registering
user cameras, fetching frames, relaying streams to the renderer, and resolving the
frame URLs of public cameras. No discovery scanning, no recognition, no retention.

## Pieces

| Module | Role |
| --- | --- |
| `types.ts` | `CameraGateway` — `status() register(source) snapshot(id) stream(id) unregister(id) list()` — plus the injected contracts (`SecretStore`, `ByteFetcher`, `UpstreamOpener`). |
| `direct-gateway.ts` | `DirectGateway`: http(s) MJPEG / HLS / still-image sources. Validates and normalizes the URL, moves `user:pass@` to the `SecretStore` under `camera.<id>.credential`, derives `cameraId = sha256(normalized url)[0:12]`, object id `camera:cameras-local:<id>`. `snapshot()` fetches ≤ 8 MiB with a timeout and validates JPEG/PNG magic bytes; MJPEG snapshots take the first frame of the stream. |
| `relay.ts` | `CameraRelay`: `node:http` server bound to `127.0.0.1:0`. Routes `GET /cam/<cameraId>/<32-hex token>` (and `/r/<path>` for HLS). 404 for unknown ids or wrong tokens, no listing, concurrency cap (503), credentials injected per request through a callback and never logged. HLS playlists are rewritten so every reference goes back through the relay and is contained to the registered playlist's directory on its origin; anything else is dropped, never proxied. |
| `go2rtc-sidecar.ts` / `go2rtc-gateway.ts` | Optional sidecar (pinned `GO2RTC_PINNED_VERSION = '1.9.14'`, same tag as `config/licenses/software.json`). Starts only when a binary path is configured **and** the file exists; generated YAML binds the API and RTSP listeners to `127.0.0.1` and disables the WebRTC/SRTP listeners; streams are added through `PUT /api/streams` (credential re-attached only for that loopback call), never written to disk. Snapshots via `/api/frame.jpeg`, streams via `/api/stream.m3u8` fronted by the relay. |
| `public-frames.ts` | `PublicFrameRegistry` + static `PUBLIC_FRAME_HOSTS` allowlist (`fintraffic` → `weathercam.digitraffic.fi`, `nsw` → `webcams.transport.nsw.gov.au`). |
| `hub.ts` | `CameraHub`: what the `camera.*` IPC handlers call. Routes by scheme (rtsp → go2rtc, http → direct) and by id shape (12-hex id → local gateway; `public:<pack>:<cameraId>` → public frame). |
| `fetch-adapters.ts` | Production `ByteFetcher` / `UpstreamOpener` over `fetch` (`redirect: 'manual'`, capped, timed out). Tests inject fakes from `testing.ts`. |

## Public camera frames: the flow

Providers only import `@worldview/world-model` and `@worldview/provider-sdk`, so the
`public-cameras` provider cannot register frame URLs with this package directly.
Instead:

1. `providers/cctv-public` emits one `camera` observation per catalog entry with
   `payload.pack`, `payload.frameUrl` (already pinned to the pack's frame host by the
   normalizer) and `payload.media = [{ kind: 'snapshot', ref: 'public:<pack>:<cameraId>' }]`.
2. The runtime ingests those into `WorldState` and, on every camera batch, calls
   `publicFrames.syncFromObjects(state.all())` (or `upsertFromObject` per `world.changed`).
3. `PublicFrameRegistry` re-validates each entry against `PUBLIC_FRAME_HOSTS` (https,
   no credentials, exact host) — defence in depth; a test asserts the gateway list equals
   the provider's pack definitions.
4. `camera.snapshot { cameraId: 'public:fintraffic:C0150201' }` → `CameraHub.snapshot()`
   → fetch with WORLDVIEW's own User-Agent → magic-byte check → bytes to the renderer.
   If the host refuses (401/403) or answers with a non-image placeholder, the frame is
   reported unavailable (`UPSTREAM_REFUSED` / `NOT_AN_IMAGE`). The gateway never
   impersonates a browser.
5. `camera.stream` for a public ref returns `{ kind: 'snapshot-poll', url }` on the relay;
   the renderer polls it no faster than `payload.refreshSeconds`.

## Local cameras: the flow

1. `camera.register { name, url, position?, headingDegrees? }` → `CameraHub.register()` →
   `{ cameraId, objectId, gateway }`.
2. The runtime persists `direct.export()` / `go2rtc.export()` (records hold the secret
   *key*, never the secret) and writes the provider settings of `cameras-local`:
   `settingsStore('cameras-local').set({ cameras: await hub.list() })` — `CameraListEntry`
   is a structural superset of the provider's `LocalCameraSetting`; unknown fields are
   ignored by its parser.
3. `providers/cameras-local` publishes one `camera` object per entry with media refs
   `camera:<cameraId>` (no URL, no secret) and works offline.
4. `camera.snapshot` / `camera.stream { cameraId }` resolve through the owning gateway.
   Stream descriptors are always loopback relay URLs with a per-camera token.

## Runtime wiring sketch

```ts
const secrets = safeStorageSecretStore();            // Electron main
const fetchBytes = createFetchByteFetcher();
const relay = new CameraRelay({ fetchBytes, openUpstream: createFetchUpstreamOpener(), logger });
const direct = new DirectGateway({ fetchBytes, openUpstream, secrets, relay, logger });
const sidecar = new Go2rtcSidecar({ binaryPath: settings.go2rtcPath, configDir, spawn, fetch, fileExists, writeFile, logger });
const go2rtc = new Go2rtcGateway({ sidecar, fetch, secrets, relay, logger });
const publicFrames = new PublicFrameRegistry({ logger });
const hub = new CameraHub({ direct, go2rtc, publicFrames, fetchBytes, relay, logger });
await relay.start(); direct.restore(persisted.direct); go2rtc.restore(persisted.go2rtc);
if (await sidecar.start()) await go2rtc.syncStreams();
// IPC: 'camera.register' → hub.register, 'camera.snapshot' → hub.snapshot, 'camera.stream' → hub.stream,
//      'camera.unregister' → hub.unregister, 'camera.list' → hub.list; CameraError.ipcCode maps to IpcError.code.
// diagnostics.sidecars ← [sidecar.status()]
```

## Error model

`CameraError { code, httpStatus?, retryable, ipcCode }` with codes `INVALID_URL`,
`UNSUPPORTED_SCHEME`, `UNSUPPORTED`, `NOT_FOUND`, `UNAVAILABLE`, `UPSTREAM_ERROR`,
`UPSTREAM_REFUSED`, `TIMEOUT`, `NETWORK`, `TOO_LARGE`, `NOT_AN_IMAGE`, `CANCELLED`,
`INTERNAL`. Messages are redacted at construction.

## Privacy and security invariants (tested)

- URL credentials never persist outside the `SecretStore`; log records never contain
  them (`direct-gateway.test.ts`, `relay.test.ts`, `go2rtc.test.ts`).
- The relay binds to `127.0.0.1` only, answers 404 for anything not registered, and
  only ever contacts the registered URL or, for HLS, resources inside its directory.
- The go2rtc sidecar never starts without a configured, present binary; its config
  contains only loopback listeners.
- Public frames are fetched only for refs that a provider registered through world
  state and whose host is on the static allowlist.
- No frame is written to disk, hashed for identity, or analysed.
