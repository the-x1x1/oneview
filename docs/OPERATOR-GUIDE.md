# Operator guide

Everything an administrator or power user needs after installing WORLDVIEW. For
building from source see [DEVELOPMENT.md](DEVELOPMENT.md).

## Install

Per-user installer (`WorldView-Setup-<version>.exe`, no admin rights) or the portable
zip (`WorldView-Portable-<version>.zip`, unzip and run `WorldView.exe`). Windows 10/11
x64. Verify the download first:

```powershell
Get-FileHash .\WorldView-Setup-<version>.exe -Algorithm SHA256
# compare against SHA256SUMS.txt from the same release
```

Current builds are unsigned, so SmartScreen warns on first run
([why](releases/KNOWN-LIMITATIONS.md)).

### Where data lives

| Path (`%APPDATA%\WorldView\`)                        | Contents                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `settings.json`                                      | application settings (atomic writes, migrated on upgrade)                                                                       |
| `credentials.json`                                   | API keys, encrypted with Windows DPAPI                                                                                          |
| `collections.json`, `watchzones.json`, `lenses.json` | your saved work                                                                                                                 |
| `cameras.json`                                       | cameras you added (addresses, never passwords)                                                                                  |
| `history/`                                           | observation history, partitioned by type and date                                                                               |
| `worldpacks/`                                        | installed offline packs                                                                                                         |
| `provider-cache/`                                    | provider response cache (only for sources whose policy permits caching)                                                         |
| `tiles/`                                             | map tiles kept for Esri World Imagery, under the cap set in Settings                                                            |
| `logs/`                                              | rotating structured logs, redacted; a warning repeated every poll is written once, then as a `repeated: N` summary every 10 min |

The portable build uses the same paths, so an installed and a portable copy share data.

## Providers and credentials

Settings → Sources lists every provider with its state, refresh interval, attribution,
terms link and data policy. Enable or disable each one; changes take effect immediately.

Open a source to configure it. Each provider declares what it accepts in its own
manifest and the panel renders that, so the choices you see are the ones that provider
honours: the USGS feed window and minimum magnitude, CelesTrak catalogue groups, FIRMS
satellites and day range, the NWS contact and state filter, which public-camera packs
are on, and the local ADS-B endpoint. Clearing a field returns the provider to its own
default rather than storing an empty value. Changes apply on the next refresh.

Providers that work with no credentials: USGS earthquakes, CelesTrak satellites, NWS
weather alerts (US), adsb.lol aircraft, public camera catalogs, bundled airports.

| Provider                              | Credential          | Where to get it                                                 |
| ------------------------------------- | ------------------- | --------------------------------------------------------------- |
| NASA FIRMS (fires)                    | `firms.mapKey`      | <https://firms.modaps.eosdis.nasa.gov/api/map_key/> (free)      |
| AISStream (vessels)                   | `aisstream.apiKey`  | <https://aisstream.io> — review the terms before commercial use |
| Cesium ion (optional imagery/terrain) | `cesium.ionToken`   | <https://ion.cesium.com> — free tier is non-commercial          |
| Google Map Tiles (optional 3D)        | `google.mapsApiKey` | Google Cloud, your own billing                                  |
| TomTom (optional traffic)             | `tomtom.apiKey`     | <https://developer.tomtom.com>                                  |

Enter keys in Settings → Sources → _provider_ → Credentials. They are written to
OS-protected storage; the interface can ask whether a key exists but can never read it
back, and keys never appear in logs, errors or diagnostics exports. A provider without
its required key sits at `AUTH_REQUIRED` and makes no requests.

Some sources are off by default because their commercial terms are unresolved
([review](legal/COMMERCIAL-DISTRIBUTION-REVIEW.md)). Read the terms before enabling them
in a commercial setting.

## Offline packs

Settings → Offline → Install pack, or:

```
pnpm worldpack build --region hawaii --include map,places,airports,earthquakes
pnpm worldpack verify hawaii.worldpack
```

Presets: `hawaii`, `japan`, `california`, `uk`, `western-europe`, `australia-east`,
`us-gulf-coast`; or `--bbox west,south,east,north`. A basemap needs a PMTiles extract
you supply (`--pmtiles`), because no basemap is bundled by default — see
[OFFLINE-PACKS.md](OFFLINE-PACKS.md) for a legal source and the exact commands.

Import verifies structure, paths, checksums and source policies before writing
anything; a tampered or hostile pack is refused and leaves nothing behind. Packs
contain data only — never code.

## Local ADS-B (readsb / dump1090)

Run readsb or dump1090-fa yourself, with its JSON output enabled. In Settings → Sources
→ Local ADS-B set the endpoint (default `http://127.0.0.1:8080/data/aircraft.json`).
WORLDVIEW probes that one endpoint — it never scans your network. Aircraft from your own
receiver keep updating when the internet is down, and merge with remote sources on
ICAO24 without duplicating.

For a receiver on another machine on your LAN, set the trusted host explicitly; plain
HTTP is allowed only to loopback and to a host you name.

## Cameras

Public catalogs (Fintraffic, Live Traffic NSW, TfL JamCams, Ontario 511, DriveBC, City of Calgary) need no configuration; enable the
provider. For your own cameras, Settings → Cameras → Add: MJPEG, HLS and JPEG snapshot
URLs work directly. RTSP needs the optional go2rtc sidecar: download and verify it
yourself, then give Settings → Cameras the absolute path to the binary. Nothing is
downloaded on your behalf and nothing starts until an RTSP camera is actually used; an
empty path means RTSP cameras are refused rather than accepted and left dead. See
[operator/cameras.md](operator/cameras.md) for the pinned version, checksum
verification and what the sidecar is allowed to do. Credentials embedded in a camera URL are moved into protected storage on
registration. Frames are relayed through a loopback-only endpoint, are not stored, and
nothing analyses their content.

## Diagnostics

Help → Diagnostics shows version and channel, runtime, per-provider health, database
backend and size, installed packs, renderer and GPU, sidecar status, updater state and
disk usage. **Export Diagnostics** writes a redacted bundle (secrets removed, home
directory replaced with `~`) — review it before sharing.

From a source checkout, `pnpm run doctor` checks the machine: Node version, installed
dependencies, Cesium assets, DuckDB availability, bundled data, provider configuration,
write permissions, and optional sidecars. Checks that cannot run report `SKIP` with the
reason rather than a false pass.

## Updates

Settings → Updates: channel (`stable` or `prerelease`) and automatic updates. While
builds are unsigned, WORLDVIEW checks for updates and tells you one exists but never
installs on its own; download and run the installer yourself. A prerelease never
replaces a stable installation unless you opt in (ADR-012).

## Backups

Everything worth keeping is JSON or Parquet under `%APPDATA%\WorldView\`. Copy that
directory while the app is closed. To move to another machine, copy it across —
`credentials.json` will not decrypt there (it is bound to the Windows account), so
re-enter keys. Collections and lenses can also be exported individually from the
Collections panel.

To reset a corrupt installation: close the app, rename `settings.json`, reopen.
WORLDVIEW preserves a corrupt file as `settings.corrupt-<timestamp>.json`, starts from
defaults and reports the finding in Diagnostics rather than deleting your data.
