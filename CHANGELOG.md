# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [semantic versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Electron's and esbuild's install scripts were never running. pnpm 10 blocks a
  dependency's install scripts unless the repository names it, and neither was named:
  `pnpm install` finished with a warning, no Electron binary, and therefore no `pnpm dev`
  and no packaging. Declared in `pnpm.onlyBuiltDependencies`.
- `@duckdb/node-api` was declared as `>=1.2.0`, which matches none of its published
  versions — they all carry an `-r.N` prerelease suffix, and a semver range without a
  prerelease never matches one. `pnpm install` failed outright on the optional history
  backend. Pinned to `1.4.5-r.1` (the `lts-v1.4` line).
- `pnpm doctor` is also a pnpm command, so the script of that name was shadowed: the CI
  step that was meant to run WORLDVIEW's environment checks ran pnpm's own diagnostics
  instead, while `continue-on-error: false` made it look enforced. Every invocation is
  now `pnpm run doctor`, and a test fails the build if a script name is shadowed and
  invoked without `run`.

## [0.1.0-rc.3] — 2026-09-21

An audit for "code that does less than it appears" found eight more gaps; this
closes them. Nothing here is a new feature in the sense of new scope — it is the
scope that was already documented, made to work.

### Added

- **Local cameras work end to end.** Settings → Cameras adds a camera by URL,
  lists what is registered and removes it. Registrations persist in
  `cameras.json` and are restored into their gateway at startup; camera logins go
  to the OS credential store like provider keys. Previously nothing in the
  interface called `camera.register`, a restart left the marker on the map with
  no registration behind it, and credentials were held in memory while the
  operator guide promised otherwise.
- **Provider settings are configurable.** A provider declares what it accepts in
  its manifest and the source panel renders that declaration — USGS feed window
  and magnitude floor, CelesTrak groups, FIRMS satellites and day range, the NWS
  contact and state filter, public-camera packs, the local ADS-B endpoint.
  `sources.settings.get`/`.set` had been implemented and never called.
- **`events.types.list`** reports which event types this build can actually
  raise, resolved against the registered rules and the enabled sources. The
  watch-zone panel renders it instead of a hardcoded list that offered two types
  nothing could produce and omitted `watch-zone-entry`, without which object
  entry alerts never fire.
- **`camera.list` gains a named contract type**, and the live camera view plays
  MJPEG and polled stills, saying plainly that HLS and WebRTC cannot play here.

### Fixed

- Search commands and parsed queries were clickable no-ops; all thirteen
  commands now run, and a query is executed and framed.
- A failed history read was rendered as "this object has no track"; it is now
  reported in Diagnostics with the reason.
- `world.related`'s comment claimed provider-based relation; it is proximity, and
  the panel now labels that list "Nearby".
- `img-src` allows the loopback camera relay, with a test that loopback is
  permitted in no other directive.

## [0.1.0-rc.2] — 2026-09-21

Four gaps closed between the interface and the runtime, and three overstated claims
corrected. No breaking changes to the frozen contracts; two additive ones.

### Added

- **Map-provider registry** (`map.providers.list`) — the runtime serves the basemap and
  terrain catalog resolved against configured credentials, installed world packs and
  connectivity, so an entry the installation cannot use arrives marked unavailable with
  the reason to show. The interface no longer carries a hardcoded catalog of its own.
- **go2rtc sidecar, composed** — RTSP cameras now work when the operator supplies the
  binary (Settings → Cameras, `AppSettings.cameras.go2rtcPath`). The sidecar was written
  and tested but never constructed, so RTSP could not work in any build. Nothing is
  downloaded or spawned until an RTSP camera is actually used; a relative path is
  rejected, and the spawn runs with no shell.
- **NWS zone geometry** — alerts that carry no polygon of their own (most watches and
  advisories) are drawn from the outlines of the zones they name, fetched from
  api.weather.gov and cached for a month, bounded to 20 new zones per poll. An alert is
  admitted only when every one of its zones is resolved, and is labelled
  `zone-geometry` so its shape is never read as one a forecaster drew.
- **`AppSettings.firstRunCompleted`** — first-run state is persisted settings rather
  than renderer storage, which is unavailable under the sandbox and disagreed with the
  settings file after a reset.
- **Documentation guards** — `tools/dev/docs-claims.test.ts` verifies that every test
  the threat model cites exists and that each threat states mitigation, verification and
  residual risk; `tools/dev/product-boundary.test.ts` enforces the shape of
  `PRODUCT-BOUNDARIES.md` in code.

### Changed

- `basemapId` defaults to `natural-earth` (the bundled, zero-credential imagery).
- The presentation benchmark's headline figure now counts the whole in-thread update
  (present _and_ diff) rather than `present` alone. That changes the reported local-zoom
  frame budget from 100k objects to 50k: the number was an overstatement of roughly the
  cost of the diff, not a regression.

### Fixed

- Registering an RTSP camera with no sidecar configured was accepted and could never
  stream; it is now refused with an explanation.
- The threat model cited six tests that did not exist under those names, and three
  threats were missing a stated residual risk.

## [0.1.0-rc.1] — 2026-09-21

First release candidate: a working Windows desktop application, not a scaffold.

### Added

- **World model** — canonical `Observation`, `WorldObject`, `WorldEvent`, provenance,
  deterministic identifiers, per-type freshness policies, a documented confidence model
  and a dependency-free schema validator (`architecture-contract-v1`).
- **Provider SDK and runtime** — manifests with a mandatory data policy, capability-based
  provider context, host allowlists, timeouts, bounded retries, circuit breakers, rate
  limiting, request coalescing, stale-on-error, structured health, and a 16-check
  contract checklist (`pnpm provider:test`) that is the definition of "provider complete".
- **Providers** — USGS earthquakes, CelesTrak satellites, NASA FIRMS fires (key
  required), NWS weather alerts, adsb.lol aircraft, local readsb receiver, AISStream
  vessels (key required, off by default), public CCTV catalogs (Fintraffic, Live Traffic
  NSW), user cameras, and a bundled airport dataset.
- **World state** — batched ingest, deterministic cross-source identity resolution,
  grid spatial index (100k objects, bbox query in single-digit milliseconds), freshness
  sweeps, expiry, per-object tracks.
- **History and timeline** — partitioned Parquet/NDJSON history with policy-aware
  retention and tiered downsampling; LIVE / PAUSED / REPLAY / HISTORICAL modes with
  honest availability boundaries.
- **Rendering** — one rendering contract with Cesium (3D) and MapLibre (2D) adapters,
  level-of-detail from density cells to icons, clustering, label decluttering, trails,
  2D/3D view synchronisation and suspension of the hidden renderer.
- **Interface** — React shell with lenses, search (deterministic grammar, no LLM),
  context panels by object type, source health, world feed, collections, watch zones,
  settings, diagnostics, command palette, first-run flow and a demo mode labelled
  RECORDED DATA.
- **Offline** — `.worldpack` data containers with hardened import (path traversal,
  symlinks, executables, decompression bombs, checksum verification), a builder CLI, a
  local place index, connection-state monitoring, and a network-disabled test group that
  is the basis for every offline claim.
- **Cameras** — gateway with a loopback-only relay, credential stripping into OS-protected
  storage, optional pinned go2rtc sidecar, and no frame analysis of any kind.
- **Security** — context isolation, sandbox, strict CSP, navigation lock, allowlisted and
  schema-validated IPC with no generic execute/read/fetch channel, DPAPI-backed
  credential storage, central redaction, and a threat model with a verifying test per
  mitigation.
- **Release engineering** — fail-closed CI, Windows packaging, CycloneDX SBOM, license
  audit, verification report, doctor, marker report, and a human QA checklist.

### Known limitations

See [docs/releases/KNOWN-LIMITATIONS.md](docs/releases/KNOWN-LIMITATIONS.md). The
headline ones: builds are unsigned (automatic installation stays disabled), offline 3D
terrain is ellipsoid-only, FIRMS and AISStream need keys, and 27 providers/sources
remain conditional or under legal review and are off by default.

### Upstream

Adapted from [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) at
`0dbde1e3` (MIT). Deliberately not carried over: the Google-3D-first startup path,
non-commercial datasets (TeleGeography cables, Bhote Koshi), Google-derived camera ground
heights, the ALPR layer (privacy boundary), Google News (non-commercial terms), OpenSky
(non-commercial licence), and the voice/director/cockpit subsystems. See
[UPSTREAM.md](UPSTREAM.md).
