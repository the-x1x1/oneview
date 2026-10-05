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
weather alerts (US), adsb.lol aircraft, Digitraffic Marine AIS ships (the Baltic around
Finland), public camera catalogs, bundled airports.

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

## Your own sources (connector definitions)

A feed that publishes JSON, GeoJSON or CSV over HTTPS, or JSON over a WebSocket, can be
added without a release: write a definition file and put it in
`%APPDATA%\WorldView\connectors\` (one `.json` per source). It is read at the next start
and appears in Settings → Sources under its own name, off until you switch it on, with the
attribution and terms you wrote into it and any credential it names in the Credentials
section. A file that does not validate is skipped and the reason is in the log
(`connector definition rejected`); the other files still load.

What a definition can and cannot do is fixed: it names where the data is and how its
fields map onto an object — nothing in it runs as code — and its data policy is the most
restrictive there is (no redistribution, no offline packs, no export, commercial use
unknown) until the source is reviewed and shipped with the application. The format, the
fields and worked examples are in [connectors/OVERVIEW.md](connectors/OVERVIEW.md); a
developer machine can draft one from a URL with `pnpm connector:add --url …` and check it
with `pnpm connector:test`.

## Working offline

Settings → Network → **Work offline** makes WorldView ask nothing of the internet, whether
or not the computer is connected. Sources on the internet pause (Sources says Offline), the
top bar reads OFFLINE, and every request that would leave the computer — a map tile, an
imagery frame, a place lookup, an update check, the reachability probe — is refused before
it is sent (`apps/desktop/src/main/network-gate.ts`; the log notes each host once under
`offline`). What keeps working:

- the map from what is on disk: the bundled Natural Earth world, the tile cache (Settings →
  Map tile cache; the preload fills it for the whole globe down to zoom 7 where the source
  allows it) and an installed pack's basemap;
- the timeline, replay, tracks and History, from recorded history;
- search, from the objects you have and the built-in places (countries, regions, 7,342
  cities and towns) plus a pack's places;
- satellites, moved on from the last element sets by SGP4;
- sources on this computer or your own network (a local receiver, an MQTT broker, Home
  Assistant, the camera relay).

Turn it off to go back online; sources resume on their next poll.

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

With a pack installed, the 2D map's **WORLDVIEW dark** and **WORLDVIEW light** basemaps draw
its PMTiles extract, online or off; without one they are listed but cannot be chosen.

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

## Meshtastic (your own mesh)

If one of your Meshtastic nodes has Wi-Fi or Ethernet with its network API on (or you run
`meshtasticd` on this computer), Settings → Sources → Meshtastic mesh reads your mesh through
it: set the node's name or address (blank = this computer) and the port (4403 unless you
changed it), then switch the source on. WORLDVIEW connects to that one node — it never
searches your network — asks it once for its node list, and from then on draws every node
that shares its position as a sensor, with its name, battery, voltage, signal, hops and any
environment readings, updated as the node hears them. A position the sender coarsened is drawn
with its uncertainty. Nodes without a position are counted in Source Health but not drawn.

Text messages are never read: their words reach no record, log or observation. The mesh can
carry other people's nodes, so this source's data stays on the computer — no export, packs or
redistribution. A node over Bluetooth or USB is not read yet.

## NMEA 2000 (your boat)

If your boat's NMEA 2000 network has a gateway that serves it as Yacht Devices RAW over TCP
(a Yacht Devices YDWG-02 or YDEN-02, or another gateway or multiplexer that offers "YD RAW"),
Settings → Sources → Your boat (NMEA 2000 gateway) reads it: on the gateway's web page set one
of its servers to TCP and RAW, then give the gateway's address and that server's port here
(blank = this computer; 1457 by default) and switch the source on. WORLDVIEW connects to that
one gateway, never searches the network, and only reads: nothing is sent onto the boat's bus.

The boat appears as a vessel at its GNSS position with its course and speed over ground, its
heading (magnetic headings are made true when the network gives the variation), depth, speed
through water, apparent and true wind, water and air temperature and pressure — whatever its
instruments send — and the Readings tab plots them over time. With two GNSS receivers on the
bus, one is used until it falls silent for 30 seconds. Ships your boat's own AIS receiver hears
are drawn as from any AIS source, named once their static reports arrive. Give your boat's MMSI
(optional) and it is the same object as when another AIS source hears it, its flag is shown,
and your transponder's reports of itself are not drawn as a second ship. Only RAW over TCP is
read: Actisense and other formats, and gateways on USB, are not.

## Cameras

Public catalogs (Fintraffic, Live Traffic NSW, QLDTraffic, TfL JamCams, Ontario 511, DriveBC, City of Calgary, Hong Kong
Transport Department, Vegagerðin, Taiwan, IDOT's Illinois Gateway cameras, and Singapore's LTA as a source of its own) need no configuration and are on by default; Sweden (Trafikverket) needs your own
free API key, pasted in Sources → Public cameras → Credentials, and Spain (DGT) is off until you turn it on. Catalogs whose image licence is not
confirmed (Caltrans, Austin, New York City, Iowa, NZTA, Washington State, Lithuania, and — each with your own free key — 511NY, UDOT, AZ511, 511GA and Idaho 511) are a separate source, off by default, that you can switch on in Sources. For your own cameras, Settings → Cameras → Add: MJPEG, HLS and JPEG snapshot
URLs work directly. RTSP needs the optional go2rtc sidecar: download and verify it
yourself, then give Settings → Cameras the absolute path to the binary. Nothing is
downloaded on your behalf and nothing starts until an RTSP camera is actually used; an
empty path means RTSP cameras are refused rather than accepted and left dead. See
[operator/cameras.md](operator/cameras.md) for the pinned version, checksum
verification and what the sidecar is allowed to do. Credentials embedded in a camera URL are moved into protected storage on
registration. Frames are relayed through a loopback-only endpoint, are not stored, and
nothing analyses their content.

## Search

The box at the top searches as you type, on this machine only: objects on the map (callsign,
registration, MMSI, name), events, places in the built-in gazetteer (cities, airports by
name or code, coordinates such as `21.3, -157.9`, `21°18'25"N 157°51'30"W`, an MGRS reference
such as `4QFJ1234567890` or a UTM one such as `4Q 612345 2358765`), commands ("switch to 3D", "source
health", "aviation lens") and queries ("M5+ earthquakes last 24 hours", "earthquakes near
Japan"). Enter picks the first row: a command or query named in full runs (a query with one
match selects it, with several frames them); a place or an object flies there.

An MGRS reference goes to the middle of the square it names (1 m for ten figures, 1 km for
four). The letters are checked against the zone and latitude band, and a UTM coordinate's
point against its band letter; one that cannot be right is not flown to, and the line under
the list says why. N and S after a UTM zone are read as the hemisphere only when they cannot be
the band: `18S 585628 4511322` (S for band S, or for south?) is refused as ambiguous — write the
band (`18T`) or use MGRS. Settings → Rendering → Grid reference in the HUD shows the view
centre in MGRS or UTM and gives the pointer's position (CUR) in it. Neither covers the polar
caps beyond 84° N and 80° S.

Nothing leaves the machine while you type. For an address or a place the gazetteer does not
know, the list offers **Search places online for …**; Enter (or a click) on it sends that one
request to OpenStreetMap's Nominatim (or Photon, Settings → Search), at most one a second,
and the answer is kept for a day. "fly to", "go to" and "take me to" are not sent: "fly to
Hilo" asks for Hilo, and "fly to" alone asks where to. Settings → Search switches online
search off. Ctrl+K opens the command palette; `/` puts the cursor in the search box.

## Map tools

- **HUD** (H, Settings → Rendering): the view centre in degrees and degrees-minutes-seconds,
  the point under the pointer (CUR), altitude or zoom, heading, pitch and the UTC time of what
  the map shows. With something selected, RNG gives the distance and bearing from it to the
  pointer. Settings → Rendering → Grid reference in the HUD adds the centre's MGRS or UTM
  reference and gives CUR, and the selection's Position, in it.
- **Grid** (G): latitude and longitude lines spaced for the view, each named once.
- **Satellite footprint**: a selected satellite gets two rings round the point beneath it —
  where it is above the horizon (dashed) and where it is at least 10° up, the elevation its
  listed passes start at.
- **Range rings** (R): four rings round the selection at a round spacing chosen from the view,
  each labelled with its distance; they follow the selection as it moves.
- **Measure** (M, or the ruler beside 2D/3D): every click adds a point; the panel gives each
  leg's distance and initial bearing and the total. **Area** closes the shape back to the first
  point and gives the area it encloses (hectares and acres for a field, nmi² and mi² beyond),
  or says the outline crosses itself. Distances, bearings and areas are on the WGS84 ellipsoid
  and agree with GeographicLib (areas within 0.01% for a shape 1,000 km across, 0.2% for one
  the size of a continent); within a fraction of a degree of the antipode a distance is the
  spherical one, within 0.1%. The line is drawn along the great circle.

## Watch zones and notifications

The Watch zones tab of the right-hand rail: a circle round the middle of the view with a
radius, or a polygon from typed coordinates. A zone watches the event types you tick (earthquakes, warnings,
storms, objects entering it …) at or above its minimum severity. Every hit is an event in the
feed. Whether it also interrupts you is the zone's to say:

- **In-app** shows a notice in the window.
- **Desktop** shows a Windows notification, only for hits at or above the zone's desktop
  minimum severity (INFO ones make no sound). One hit raises one notification.
- **Quiet hours** hold back both for anything below SEVERE; the event is still listed.

The same object or event in the same zone notifies once in six hours unless its severity
rises.

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
