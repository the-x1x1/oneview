# Operator guide — cameras

WORLDVIEW shows two kinds of cameras on the map: **public cameras** from openly
licensed catalogs (on by default, nothing to configure) and **your own cameras**
(added by you, stored only on your machine). See docs/PRODUCT-BOUNDARIES.md for what
the camera system deliberately does not do.

## Public cameras

The `public-cameras` source loads camera catalogs every 15 minutes:

| Pack | Coverage | Licence | Frame refresh |
| --- | --- | --- | --- |
| `fintraffic` | Finnish road-weather cameras (Fintraffic / digitraffic.fi) | CC BY 4.0 | 600 s |
| `nsw` | Live Traffic NSW cameras (Transport for NSW) | CC BY 4.0 | 60 s |

Each pack can be switched off in the source's settings (`packs: { nsw: false }`).
Frames are fetched live from the pack's official image host when you open a camera,
with WORLDVIEW's own User-Agent. If a host refuses that client, the camera shows
"frame unavailable" — WORLDVIEW does not pretend to be a browser to get around it.
Attribution is shown on every camera and in Data & Attribution.

## Adding a local camera

Sources → Local cameras → Add camera. You give a name, the URL, and optionally the
position and the direction the camera faces (degrees, 0 = north).

| URL | Needs | Notes |
| --- | --- | --- |
| `http(s)://…/snapshot.jpg` (any still image URL) | nothing | Polled; the still is refreshed while the camera is open. |
| `http(s)://…/video.mjpg`, `…/mjpeg/…`, `…?action=stream` | nothing | MJPEG, streamed live. |
| `http(s)://…/index.m3u8` | nothing | HLS. Segments must live under the playlist's directory on the same host. |
| `rtsp://…` / `rtsps://…` | go2rtc sidecar (below) | Most IP cameras and NVRs. |

If the camera needs a login, put it in the URL once (`http://user:password@192.168.1.10/…`).
WORLDVIEW removes it from the URL immediately, stores it in the operating system's
protected credential storage, and attaches it only when it talks to that camera. It is
never written to settings, logs or diagnostics exports. Re-add the camera without the
`user:password@` part to remove the stored credential.

Cameras are identified by their URL: adding the same URL twice updates the existing
entry instead of creating a duplicate.

## go2rtc (optional, for RTSP)

RTSP cameras are decoded by [go2rtc](https://github.com/AlexxIT/go2rtc), an MIT-licensed
program that WORLDVIEW does **not** bundle. You download it yourself, verify it, and
tell WORLDVIEW where it is.

1. Download the release pinned by this WORLDVIEW build — **v1.9.14** — for your platform
   from the go2rtc releases page. Do not take "latest": WORLDVIEW warns in Diagnostics
   if the running version differs from the pinned one.
2. Verify the download against the checksum published with that release
   (`sha256sum go2rtc_win64.zip` / `Get-FileHash` on Windows) before running it.
   Unpack the single `go2rtc` / `go2rtc.exe` binary somewhere stable, e.g.
   `C:\Program Files\WorldView\sidecars\go2rtc.exe` or `/opt/worldview/go2rtc`.
3. Settings → Cameras → go2rtc binary → paste the **absolute** path to that file and
   Save. A relative path is refused, because it would be resolved against whatever
   directory the app happened to start in. No restart is needed: the setting takes
   effect immediately, and the sidecar starts the first time you add or open an RTSP
   camera. Diagnostics → Sidecars then shows `go2rtc: running` with the version.
   Clearing the field stops it again.

What WORLDVIEW does with it:

- writes its own configuration (`go2rtc.yaml` in the app data directory, regenerated on
  every start) that listens on `127.0.0.1:1984` (API) and `127.0.0.1:8554` (RTSP) only
  and disables the WebRTC/SRTP listeners — nothing is reachable from other machines,
  and the go2rtc web UI is never exposed by the app;
- starts it as a separate process — on demand, the first time an RTSP camera is added
  or opened, never at launch — and stops it when WORLDVIEW exits or when you clear the
  path. It is run directly, with no shell involved;
- adds your RTSP cameras through the loopback API when needed. Camera credentials are
  passed to go2rtc over that loopback connection only and never written into its
  configuration file.

WORLDVIEW never downloads or ships FFmpeg. If a camera needs transcoding that go2rtc
delegates to ffmpeg, install ffmpeg yourself; that is outside WORLDVIEW's distribution
(docs/legal/SOFTWARE-LICENSES.md).

If the binary path is empty or the file is missing, the sidecar never starts, adding an
RTSP camera is refused with "RTSP sources need the go2rtc sidecar (not configured)"
rather than being accepted and silently never streaming, and everything else — MJPEG,
HLS, snapshot and public cameras — keeps working. `pnpm doctor --user-data <dir>` checks
the configured path of an installation without starting anything.

## Privacy notes

- **No recognition.** Frames are displayed exactly as the camera served them. Nothing
  detects faces, plates, people or objects, and nothing indexes what is in a frame.
- **No retention.** Frames are streamed to the window that shows them and discarded.
  They are not written to disk, kept in history, included in exports, worldpacks or
  diagnostics bundles, and not used to build thumbnails that outlive the session.
- **No discovery.** WORLDVIEW never scans networks or probes addresses for cameras; it
  only ever contacts URLs you typed or catalog entries the public sources published.
- **Local only.** Stream URLs handed to the map are `http://127.0.0.1:<random port>/cam/…`
  with a per-camera secret token; the relay accepts connections from this machine only
  and answers "not found" for anything that was not registered.
- **Your camera list is yours.** It is stored in your settings (names, positions,
  headings and camera ids — never URLs or passwords), is never included in worldpacks,
  and can be exported like any of your own data.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| "frame unavailable" on a public camera | The image host refused or answered with a placeholder; try again later. Not a WORLDVIEW bug. |
| "upstream refused the request (HTTP 401/403)" | The camera wants a login, or the stored one is wrong. Re-add the camera with `user:password@`. |
| "upstream body is not a JPEG or PNG image" | The URL is not a still image (often a login page or an HTML viewer). Use the camera's snapshot or MJPEG endpoint. |
| "RTSP sources need the go2rtc gateway" | Configure the sidecar (above). |
| "go2rtc did not answer on the loopback API" | The binary started but port 1984 is busy or blocked locally; check Diagnostics → Sidecars and the app log. |
| Stream stops with "too many streams" | The relay caps concurrent streams (default 4). Close other camera views. |
