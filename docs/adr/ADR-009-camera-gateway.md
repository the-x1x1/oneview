# ADR-009 — Camera gateway

Status: Accepted · 2026-09-21 · Package: `@worldview/camera-gateway`

## Decision
`CameraGateway` (status/register/snapshot/stream/unregister) has two implementations: `DirectGateway` (MJPEG/HLS/snapshot URLs fetched by main with server-registered URLs only, GEV's hardened frame-proxy rules) and `Go2rtcGateway` (optional, pinned version, bound to 127.0.0.1 only, admin UI never exposed, spawned only when the user enables it and the binary is present). MediaMTX can implement the same interface later. Camera credentials in URLs are moved to `safeStorage` at registration. No discovery scanning, no face/plate recognition, no frame retention by default.

- 2026-09-21 amendment (sidecar composition): `Go2rtcSidecar` and `Go2rtcGateway` are composed into the runtime in every build, so `camera.*` and Diagnostics can report `not-configured` rather than the gateway being absent. The binary is operator-supplied: `AppSettings.cameras.go2rtcPath` holds an absolute path the operator installed and verified themselves, and nothing is downloaded, searched for or spawned until it names a file that exists. The settings schema rejects a relative path (which would resolve against the working directory and could pick up a planted binary) and PATH lookup is never used; `spawn` runs with `shell: false`. Registration of an RTSP camera fails with `UNSUPPORTED_SCHEME` while the sidecar is unconfigured, rather than accepting a camera that could never stream. Changing the path stops a running process before the swap; the change takes effect without a restart.
