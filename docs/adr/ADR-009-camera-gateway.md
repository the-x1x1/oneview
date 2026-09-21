# ADR-009 — Camera gateway

Status: Accepted · 2026-09-21 · Package: `@worldview/camera-gateway`

## Decision
`CameraGateway` (status/register/snapshot/stream/unregister) has two implementations: `DirectGateway` (MJPEG/HLS/snapshot URLs fetched by main with server-registered URLs only, GEV's hardened frame-proxy rules) and `Go2rtcGateway` (optional, pinned version, bound to 127.0.0.1 only, admin UI never exposed, spawned only when the user enables it and the binary is present). MediaMTX can implement the same interface later. Camera credentials in URLs are moved to `safeStorage` at registration. No discovery scanning, no face/plate recognition, no frame retention by default.
