# Operator guide — cameras

WORLDVIEW shows two kinds of cameras on the map: **public cameras** from openly
licensed catalogs (on by default, nothing to configure) and **your own cameras**
(added by you, stored only on your machine). See docs/PRODUCT-BOUNDARIES.md for what
the camera system deliberately does not do.

## Public cameras

The `public-cameras` source loads camera catalogs every 15 minutes:

| Pack           | Coverage                                                              | Licence                                    | Frame refresh |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------ | ------------- |
| `fintraffic`   | Finnish road-weather cameras (Fintraffic / digitraffic.fi)            | CC BY 4.0                                  | 600 s         |
| `nsw`          | Live Traffic NSW cameras (Transport for NSW)                          | CC BY 4.0                                  | 60 s          |
| `tfl`          | London traffic cameras (TfL JamCams)                                  | TfL Open Data ("Powered by TfL Open Data") | 300 s         |
| `ontario`      | Ontario highway cameras (Ontario 511)                                 | Open Government Licence – Ontario          | 120 s         |
| `drivebc`      | British Columbia highway cameras (DriveBC)                            | Open Government Licence – British Columbia | 300 s         |
| `calgary`      | City of Calgary traffic cameras (Open Calgary)                        | Open Government Licence – City of Calgary  | 120 s         |
| `hongkong`     | Hong Kong traffic snapshots (Transport Department, DATA.GOV.HK)       | DATA.GOV.HK Terms and Conditions           | 120 s         |
| `iceland`      | Icelandic road webcams (Vegagerðin / IRCA)                            | IRCA Terms and Conditions                  | 600 s         |
| `queensland`   | Queensland traffic cameras (QLDTraffic, Transport and Main Roads)     | CC BY 4.0 AU                               | 120 s         |
| `trafikverket` | Swedish road cameras (Trafikverket) — **needs your own free API key** | CC0 1.0                                    | 60 s          |

These are the catalogs whose licence records are approved for use by default
(config/licenses/providers.json). Trafikverket's API takes a key: register at
[data.trafikverket.se](https://data.trafikverket.se/) (free), then paste it in Sources →
Public cameras → Credentials. Until a key is stored that pack sends nothing, and the source
says it is waiting for one; the key goes into the request body by the network layer and
is never written to settings or logs. The Swedish pack's field names follow Trafikverket's
published object model and have not yet been checked against a live answer — the first
run with a key is that check (`camera catalogue` or `camera pack failed` in `app.log`). QLDTraffic takes an API key; WORLDVIEW uses the shared
anonymous key QLDTraffic publishes for developers who do not register, and leaves out the
cameras whose images come from other organisations (the feed marks them), because the
CC BY statement cannot be assumed to cover those.

### Cameras whose licence is not confirmed (off by default)

A second source, **Public cameras (licence not confirmed)** (`public-cameras-unverified`),
carries catalogs that agencies publish on their own sites but under no licence we could
find for the images:

| Pack       | Coverage                                  | What is known                                        |
| ---------- | ----------------------------------------- | ---------------------------------------------------- |
| `caltrans` | California state highways, districts 1–12 | Public JSON for Caltrans's own map; no licence text  |
| `austin`   | City of Austin, Texas                     | Catalogue is open data; the images are not licensed  |
| `nyc`      | New York City DOT                         | No terms published                                   |
| `iowa`     | Iowa DOT                                  | Catalogue CC BY 4.0; images not named in the licence |

It is **off** in a fresh install and marked _manual review required_ in Sources. Switching
it on is your decision. While it is on, its cameras are kept for at most a day, never go
into exports or offline packs, and their frames — like every camera's — are fetched live
and never stored. Tallinn, Estonia's Transpordiamet, TxDOT and Warendorf have registry
records but are not built; see docs/legal/DATA-SOURCE-LICENSES.md.

Each pack can be switched off in Sources → (source) → Settings.
Frames are fetched live from the pack's official image host when you open a camera,
with WORLDVIEW's own User-Agent. If a host refuses that client, the camera shows
"frame unavailable" — WORLDVIEW does not pretend to be a browser to get around it. A host
that answers with a redirect is followed at most twice, and only to an address the same
pack is allowed to serve frames from (Hong Kong's image host redirects to the current
frame). Attribution is shown on every camera and in Data & Attribution.

## Adding a local camera

Settings → Cameras → Add camera. You give a name, the URL, and optionally the position
and the direction the camera faces (degrees, 0 = north). The same panel lists the
cameras you have added and removes them.

| URL                                                      | Needs                  | Notes                                                                    |
| -------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `http(s)://…/snapshot.jpg` (any still image URL)         | nothing                | Polled; the still is refreshed while the camera is open.                 |
| `http(s)://…/video.mjpg`, `…/mjpeg/…`, `…?action=stream` | nothing                | MJPEG, streamed live.                                                    |
| `http(s)://…/index.m3u8`                                 | nothing                | HLS. Segments must live under the playlist's directory on the same host. |
| `rtsp://…` / `rtsps://…`                                 | go2rtc sidecar (below) | Most IP cameras and NVRs.                                                |

If the camera needs a login, put it in the URL once (`http://user:password@192.168.1.10/…`).
WORLDVIEW removes it from the URL immediately, stores it in the operating system's
protected credential storage, and attaches it only when it talks to that camera. It is
never written to settings, logs or diagnostics exports. Re-add the camera without the
`user:password@` part to remove the stored credential.

Cameras are identified by their URL: adding the same URL twice updates the existing
entry instead of creating a duplicate.

Your cameras are written to `cameras.json` in the app data directory — the address, with
any login stripped out — and are re-registered when WORLDVIEW starts, so they keep
working across restarts. The password lives only in the operating system's credential
store and is re-attached when that camera is fetched.

Selecting a camera shows a still by default and a **Live** button. MJPEG cameras play
live in the window. A still-image camera refreshes on a timer under Live. HLS and WebRTC
cameras do not play here — Chromium plays neither natively and no player library is
bundled — so the panel says so and keeps showing live stills rather than a frozen frame
under a "Live" label; the relay URL works in a player such as VLC.

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
HLS, snapshot and public cameras — keeps working. `pnpm run doctor --user-data <dir>` checks
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

| Symptom                                       | Meaning                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| "frame unavailable" on a public camera        | The image host refused or answered with a placeholder; try again later. Not a WORLDVIEW bug.                      |
| "upstream refused the request (HTTP 401/403)" | The camera wants a login, or the stored one is wrong. Re-add the camera with `user:password@`.                    |
| "upstream body is not a JPEG or PNG image"    | The URL is not a still image (often a login page or an HTML viewer). Use the camera's snapshot or MJPEG endpoint. |
| "RTSP sources need the go2rtc gateway"        | Configure the sidecar (above).                                                                                    |
| "go2rtc did not answer on the loopback API"   | The binary started but port 1984 is busy or blocked locally; check Diagnostics → Sidecars and the app log.        |
| Stream stops with "too many streams"          | The relay caps concurrent streams (default 4). Close other camera views.                                          |
