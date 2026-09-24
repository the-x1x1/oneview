# Phase `files` — Local files: GeoJSON, CSV, GPX, KML; GDAL import

Status: merged at `a5244b5` (complete at `6a8dd9c`; the four amendments landed at `6d5f29e`, the shims removed in the commit after the merge) · Branch: `phase/files` · Target: 0.2.0 · Owner: phase agent (session 014MSZ)

Complete against the phase's shims: both connectors, the readers, the path policy, mtime polling, the
GDAL conversion, six examples, the guide and 37 tests are built and green in the container. A file
definition runs in the app only once amendments A1–A3 land (until then it is refused with a message
saying so), and `connector:test` reaches the six examples only once A1 and A4 land — they wait in
`connectors/examples/files/awaiting-amendments/`. Not run: ESLint, the Windows gate, a real `ogr2ogr`.

## Goal

A file on the operator's disk is a source: drop a GeoJSON, a CSV, a GPX track or a KML
into a definition and it is on the map, re-read when it changes. Anything else GDAL reads
is converted with `ogr2ogr` when that program is installed — never bundled, never
downloaded.

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; ADR-003's `filesystem` and
`local-process` transports and `ProviderLocalAccess`; `providers/infrastructure` (the
existing filesystem provider) and `providers/readsb-local` (a local-process one);
`packages/connector-runtime/src/connectors/csv.ts`.

## Scope

In: `local-file` — a definition whose `file.path` is under a folder the operator granted
(the provider settings name the folder; no path outside it, no symlink escape), formats
`geojson`, `csv`, `gpx` (tracks → one object per track point? no: one object per
track/waypoint with the track as `geometry`), `kml` (Placemarks: Point/LineString/Polygon,
`ExtendedData`), `topojson` (via a small converter); polling by mtime with a minimum
interval; size cap; the file's own attribution from the definition. `gdal-import` — when
`ogr2ogr` is on PATH, `local-process` conversion of shapefile/GeoPackage/FileGDB/… to
GeoJSON in a temp directory, then `local-file`; version and presence detected, never
installed.

Out: watching whole directories (a later `discovery`), writing files, raster formats,
network file shares as sources (they are paths; fine if granted).

## Deliverables

1. [x] `packages/connector-runtime/src/connectors/files/{local-file,gpx,kml,topojson,gdal-import}.ts`,
       `index.ts`; slot lines. Also `contract.ts` (the requested contracts, below), `path-policy.ts`,
       `xml.ts`, `features.ts`, `formats.ts`, `provider.ts` (what the two connectors share), and
       `testing/` (the host side of A2/A3 and the A1/A4 suite shim, test-only, not exported).
2. [x] Parsers with no dependency: GPX and KML with a tolerant tag scanner (`xml.ts`, in this
       phase's directory for the refactor pass to promote if `ogc` writes one too).
3. [x] Examples with sidecars and fixtures under `connectors/examples/files/`,
       `fixtures/connectors/files/`: one of each format, and a GDAL-import example that the suite
       runs with a fixture standing in for `ogr2ogr` output. The examples sit one level down, in
       `connectors/examples/files/awaiting-amendments/`, until A1 and A4 land (decision 7).
4. [x] `docs/connectors/files.md`: the folder grant, formats, GDAL detection, limits.
5. [x] `files.test.ts`: suite; path-escape refusal; mtime polling; size cap; parser cases.
6. [x] Changelog fragment; status and evidence.

## Definition of done

- [x] `connector:test --all` green — it exits 0, but it does not reach the six file examples
      until A1 and A4 land; the same shared suite passes on all six through the shim (evidence)
- [x] path policy tests (outside folder, symlink, UNC) refuse — on a real file system,
      junctions and symlinks included (evidence)
- [x] `phase-check` passes; the common checks the container can run are green. ESLint was
      not run (not installable here); the Windows gate runs it

## Design notes

- `ProviderLocalAccess.readGrantedFile` / `statGrantedFile` read the folder the user named
  (see the landed amendment below); `providers/infrastructure` shows the bundled-resources
  case, which is the same call against the fallback grant.
- KML `<coordinates>` are lon,lat[,alt] whitespace-separated triples; `<gx:Track>` has
  `<when>`/`<gx:coord>` pairs.
- GPX `<trkpt lat lon>` with `<ele>` and `<time>`; a track is one object with the last
  point as position and the whole as geometry; waypoints are objects of their own.
- A CSV without lat/lon but with an address is not geocoded (product boundary).

## What exists today, and what does not

Found while building, and the reason for the amendments below:

- `ProviderLocalAccess` has `readGrantedFile(path, { maxBytes })` and nothing else for files:
  no stat, so no modification time to poll by.
- The granted directory is chosen by the runtime, not by the provider's settings:
  `grantDirFor(id)` returns `localGrants[id] ?? resourcesDir`, so every provider — a connector's
  included — is granted the app's own resources directory. A file source built on that today
  would read the wrong folder.
- `createLocalAccess` checks containment lexically (`isInsideDir(grantDir, path.resolve(…))`),
  so a link or junction inside the granted directory that points out of it is followed.
- Nothing on `ProviderContext` runs a process. `readsb-local` is a `local-process` provider
  only in name: it reads HTTP from loopback.
- `definitionSchema` is a non-strict `s.object`: keys it does not know are dropped, not
  refused. A `file` block therefore never reaches `connector.validate` or `createProvider`,
  and the loader and `connector:test` refuse every file definition ("needs a file block").
- The shared suite feeds its fixtures only as HTTP response bodies (a poll) or socket messages
  (a subscription); it cannot serve a fixture as a file in a granted folder.

## Amendment requests

**All four landed at integration (2026-09-23, `develop`, ADR-003 and ADR-013 amendment
lines):** A1 `file` in the definition schema (`FileSpec`, `fileSpecSchema`, the constants,
`LAYER_NAME`); A2 the one path rule in `provider-sdk/local-files.ts` (`checkRelativePath`),
real-path containment, the handle check and no resources fallback for a declared
`grantedFolderSetting` (`runtime/support/granted-folder.ts`, from `testing/host.ts`); A3
`ProviderLocalAccess.ogr2ogr` offered only with a granted folder (same file); A4 the suite's
file mode with `testing.FixtureLocalAccess` answering as the host does and
`testing.FixtureOgr2ogr`. The shims went with the merge: `contract.ts` re-exports the SDK
contracts, `path-policy.ts` re-exports the SDK rule, `testing/host.ts` and
`testing/suite-shim.ts` are deleted (their tests moved to the runtime and onto the
fixtures), and the six examples moved up to `connectors/examples/files/`, where
`connector:test --all` runs them. The requests as written follow, for the record.

Each is written against the final shape the connectors already use (`contract.ts`); the
connectors need no change when they land, only the shim deletions listed.

**A1 — ADR-013, `packages/connector-sdk/src/definition.ts`: the definition keeps `file`.**
`ConnectorProviderDefinition.file?: FileSpec` and `definitionSchema` gains
`file: s.optional(fileSpecSchema)`, with `FileSpec`/`fileSpecSchema` moved from
`files/contract.ts` unchanged: `{ path: string(1–1024); format?: 'geojson'|'csv'|'gpx'|'kml'|'topojson';
intervalSeconds?: 5–86,400; maxBytes?: 1 KiB–64 MiB; layers?: 1–16 names matching
/^[A-Za-z0-9_][A-Za-z0-9_. ()-]{0,127}$/ }`. No refine change is needed (a definition with
`file` and no `endpoint` already passes). Test: a `file` block survives `parseDefinition`.
Then: `contract.ts` imports these from the SDK, the parenthesis about A1 in
`validateFileDefinition`'s message and the tripwire test in `files.test.ts` ("the frozen
registry drops the file block today") are deleted.

**A2 — ADR-003, `packages/provider-sdk` + `packages/runtime`: a folder the operator names.**
(1) `ProviderManifest.grantedFolderSetting?: string` — `filesystem` transport only, naming a
`string` setting, validated as `trustedHostSetting` is. For a provider that declares it the
runtime grants exactly the folder that setting names (re-read when the setting changes) and
never falls back to the resources directory; an empty setting grants nothing. (2)
`ProviderLocalAccess.statGrantedFile?(path): Promise<{ size, mtimeMs }>` — optional, additive.
(3) `readGrantedFile` and `statGrantedFile` apply the connector's path policy
(`checkRelativePath`) and then compare _real_ paths (links, junctions resolved) against the
granted folder's real path, refuse what is not a regular file, and check that the opened handle
is the file that was checked. The reference implementation and its tests are
`files/testing/host.ts` (`createGrantedFolderAccess`) and `files.test.ts`; it would replace
`createLocalAccess`'s file half. (4) `testing.FixtureLocalAccess` gains `statGrantedFile`.
Then: `testing/host.ts`'s A2 half is deleted.

**A3 — ADR-003: the host runs the operator's `ogr2ogr`.**
`ProviderLocalAccess.ogr2ogr?: { detect(); datasetStat(input); toGeoJson({ input, layer?,
timeoutMs?, maxOutputBytes?, signal? }) }`, exactly `Ogr2ogrAccess` in `contract.ts`, offered
only to providers with a `grantedFolderSetting`. The reference host is `createOgr2ogrAccess`
in `testing/host.ts`: `ogr2ogr` (`ogr2ogr.exe` on Windows) looked up on PATH, run with
`execFile` and no shell, the fixed arguments
`-f GeoJSON -t_srs EPSG:4326 -lco RFC7946=YES <tmp>/out.geojson <input> [<layer>]`, a minimal
environment (PATH, system and temp variables, `GDAL_*`/`PROJ_*`/`OGR_*`/`CPL_*`; never
`ONEVIEW_*`), a timeout, an output cap, a fresh temporary directory always removed, an input
extension allow-list that excludes formats able to reference other files (VRT, GML, …), and
every part of a dataset (a shapefile's sidecars, a `.gdb`'s files) inside the grant. No new
dependency; GDAL is not distributed, so nothing changes for the licence audit. Then:
`testing/host.ts` is deleted.

**A4 — ADR-013, `packages/connector-runtime/src/testing/suite.ts`: the suite's file mode.**
For a definition with a `file` block the suite serves each fixture as the granted file through
`FixtureLocalAccess` (with `statGrantedFile`) — and for `gdal-import` as the converter's
output — instead of as an HTTP body; the HTTP-only checks become their file equivalents:
_Timeout_ → a missing file is UNSUPPORTED, _Auth failure_ → a path outside the folder is
HOST_NOT_ALLOWED, _Rate limit_ → a second poll of an unchanged file reads nothing,
_Oversized payload_ → a file over `file.maxBytes` is TOO_LARGE before it is read. Then: the six
examples move from `awaiting-amendments/` up to `connectors/examples/files/`, where
`connector:test --all` runs them, and `testing/suite-shim.ts` and its uses in `files.test.ts`
are deleted.

Slot files: the registry has no import slot, so `registry.ts` gains one import line marked
`// phase:files` beside the Wave 1 imports; other phases' import lines will meet it there.

## Decisions

1. **One record shape for every format.** GPX, KML and TopoJSON become GeoJSON-shaped features
   with `id`, `kind`, `name`, `description`, `time` and `point` beside `properties`, so one
   mapping vocabulary (and the GeoJSON defaults) covers all five formats and a file's own
   `name` property can never collide with the reader's.
2. **A track is one object** at its last point with the whole track (segments as a
   MultiLineString) as geometry, dated by that point; routes carry no time (they are plans).
   Ids follow file order (`track-1`); the guide says to map `externalId` to `name` when names
   are unique.
3. **File time, not poll time.** Records with no time of their own are dated by the file's
   modification time and flagged `file-time`, so an unchanged file yields identical
   observations (same ids) on every poll instead of looking new every 30 s.
4. **Read only when changed; never look more often than 5 s;** a file that changes while it is
   read is served but not remembered, and a parse failure then is retryable. A failed look
   forgets what the file said before.
5. **Mixed KML MultiGeometry** keeps its highest dimension as the geometry and a single point
   member as the position (`mixedGeometry: true`); the world model has no GeometryCollection.
6. **Text:** BOM, then the XML declaration, then strict UTF-8, then Windows-1252 with a log
   line. Times without a zone are UTC (GPX says so; local time would differ by machine).
7. **Examples wait one level down.** `connector:test --all` reads `connectors/examples` and its
   immediate subdirectories. Before A1 every file definition fails its validation there, so
   the examples live in `connectors/examples/files/awaiting-amendments/` (with a README saying
   why) and `files.test.ts` runs the same frozen `runConnectorSuite` on each of them through
   the shim. Mutating a sidecar's count, a malformed body or the attribution makes that run
   fail, as it should (evidence).
8. **The shim's host side is real.** `testing/host.ts` uses `node:fs` and `node:child_process`
   so the path rules are tested against real links, junctions, a FIFO and a real child process;
   it is test-only (the package index does not export it) and is the reference for A2/A3.
9. `files.test.ts` reads sidecars with `loadSidecar` from `@worldview/tool-connector-validator`
   so they mean exactly what they will mean to `connector:test`; that test-only import goes
   when A4 lands.
10. **gdal-import converts one layer per run** (GDAL's GeoJSON writer holds one) and merges,
    prefixing ids with the layer; `ogr2ogr` absent is OFFLINE with a message and is looked for
    again every five minutes.

## Evidence

Container (Linux, Node 22.22.2), `phase/files` at `6a8dd9c`, rebased onto `develop @ b13df65`
(amendment #1, `imagery-scene`, which this phase does not use). The registry refused
`pnpm install` (403), so the toolchain is `tools/dev/link-local-toolchain.sh` and every command
is the script the pnpm alias runs. Prettier is the real 3.9.8 from the operator's `wv-build`.
**Not run:** ESLint (no package bodies in the container; the lint rules that have bitten
container code — `prefer-const`, unused imports and variables, `no-useless-escape` — were checked
by reading), the Windows gate (`check.bat`: install, lint, packaging), and a real `ogr2ogr`
(GDAL is not installed here; a stand-in program run as a real child process covers the host's
side). The symlink, junction and FIFO tests ran on Linux only; on Windows a junction needs no
privilege, the file-symlink test skips itself without Developer Mode, and the FIFO test is
skipped.

Phase check and the common checks:

```
$ node tools/dev/phase-check.mjs files --base origin/develop
[phase-check] phase=files branch=phase/files base=origin/develop (b13df655c1) files=41
 ~ docs/connectors/README.md  [shared]
 ~ fixtures/connectors/README.md  [shared]
 ~ packages/connector-runtime/src/index.ts  [shared]
 ~ packages/connector-runtime/src/registry.ts  [shared]
[phase-check] shared slot files touched: 4 (integrator reviews the slot lines)
[phase-check] PASS
exit=0

$ node tools/dev/typecheck.mjs
[typecheck] tsconfig.json (shims: @cesium/engine, @duckdb/node-api, cesium, electron, electron-updater, maplibre-gl, pmtiles, react, react-dom, react-dom/client, react-dom/server, react/jsx-runtime, satellite.js)
[typecheck] tsconfig.renderer.json (shims: @cesium/engine, @duckdb/node-api, cesium, electron, electron-updater, maplibre-gl, pmtiles, react, react-dom, react-dom/client, react-dom/server, react/jsx-runtime, satellite.js)
exit=0

$ node tools/dev/boundary-check.mjs
[boundary-check] files=662 violations=0 → PASS

$ node tools/dev/run-tests.mjs
ℹ tests 987
ℹ suites 0
ℹ pass 979
ℹ fail 0
ℹ cancelled 0
ℹ skipped 8
ℹ todo 0
ℹ duration_ms 66287.271859

[tests] group=all files=185 pass=979 fail=0 -> artifacts/verification/tests/all.json

$ node --import tsx tools/connector-validator/src/cli.ts --all
PASS connectors/examples/citibike-stations-rest.json — citibike-nyc-stations (rest-json)
PASS connectors/examples/sample-websocket.json — sample-vehicle-feed (websocket-json)
PASS connectors/examples/usgs-earthquakes-csv.json — usgs-earthquakes-csv (csv)
PASS connectors/examples/usgs-earthquakes-geojson.json — usgs-earthquakes-connector (geojson)
exit=0

$ node --import tsx tools/license-audit/src/cli.ts
0 errors, 0 warnings → PASS
$ node --import tsx tools/dev/todo-report.mjs
[todo-report] files=587 markers=0
$ node tools/dev/stage-resources.mjs --check
[stage-resources] up to date: apps/desktop/resources/data/airports.geojson
[stage-resources] up to date: apps/desktop/resources/data/demo-earthquakes.geojson
$ prettier --check .   (prettier 3.9.8 from wv-build)
All matched files use Prettier code style!
```

`connector:test` on a file example today — the frozen schema drops the `file` block (A1):

```
$ node --import tsx tools/connector-validator/src/cli.ts connectors/examples/files/awaiting-amendments/kml-reef-survey.json
FAIL connectors/examples/files/awaiting-amendments/kml-reef-survey.json — kml-reef-survey (local-file)
  ✗ a local-file source needs a "file" block naming the file inside the granted folder, e.g. { "path": "tracks/run.gpx" } (a build whose definition schema does not keep "file" yet — ADR-013 amendment A1, docs/connectors/files.md — refuses every file definition here)

exit=1
```

The phase's tests (`node --import tsx --test packages/connector-runtime/src/connectors/files/files.test.ts`):

```
ok 1 - every file example has a sidecar, and there is one per format plus GDAL
ok 2 - shared connector suite: csv-rain-gauges.json (through the A1/A4 shim)
ok 3 - shared connector suite: gdal-parcels.json (through the A1/A4 shim)
ok 4 - shared connector suite: geojson-community-gardens.json (through the A1/A4 shim)
ok 5 - shared connector suite: gpx-diamond-head-walk.json (through the A1/A4 shim)
ok 6 - shared connector suite: kml-reef-survey.json (through the A1/A4 shim)
ok 7 - shared connector suite: topojson-districts.json (through the A1/A4 shim)
ok 8 - the suite run through the shim fails when it should: a wrong count, an accepted malformed body, a wrong attribution, an escaping path
ok 9 - the frozen registry drops the file block today (amendment A1): when this fails, A1 has landed — delete the shim
ok 10 - path policy: relative paths inside the folder are accepted and normalised
ok 11 - path policy: outside the folder, UNC, device, drive, stream and Windows-aliased names are refused
ok 12 - a definition naming a path outside the folder does not validate, and no provider is built for it
ok 13 - granted folder: reads inside it; refuses a link out of it, a missing file, a folder and no grant at all
ok 14 - granted folder: a file link out of the folder is refused (needs symlink rights on Windows)
ok 15 - granted folder: a FIFO is not read (it would block the poll forever)
ok 16 - containment compares real paths, case-insensitively only on Windows
ok 17 - local-file polls the modification time and re-reads only when the file changed, never more often than every 5 s
ok 18 - local-file refuses a file over its size cap before reading it, and a link out of the folder
ok 19 - local-file on a host without the granted-folder amendment reports UNSUPPORTED and reads nothing
ok 20 - manifest: filesystem transport, no hosts, the folder setting the host grants, a cadence the rate policy covers
ok 21 - a file that changes while it is read is served but not remembered; unparseable mid-write it is retried
ok 22 - xml: entities, CDATA and comments; a DOCTYPE is skipped and its entities never expanded
ok 23 - xml: tolerant of stray end tags and unclosed elements; strict about no root, unclosed tags and caps
ok 24 - gpx: GPX 1.0 links, times without a zone as UTC, a one-point track as a Point, a track without points skipped
ok 25 - kml: homogeneous MultiGeometry, nested folders, Model, mismatched gx:Track, a Placemark with no geometry
ok 26 - topojson: arcs shared and reversed, layer selection, an unknown layer, an unquantized topology
ok 27 - a .json file is TopoJSON or GeoJSON by its content; a single Feature file is one record
ok 28 - text decoding: BOMs, a declared XML encoding, and Windows-1252 when a file is not UTF-8
ok 29 - validation: what a local-file definition may not say
ok 30 - gdal-import validation: self-contained formats only; VRT and friends refused; formats local-file reads sent there
ok 31 - gdal-import without ogr2ogr is OFFLINE with a message, and looks again only after five minutes
ok 32 - gdal-import on a host without the converter amendment reports UNSUPPORTED
ok 33 - gdal-import converts several layers one at a time and keeps their ids apart
ok 34 - ogr2ogr host: fixed arguments, no shell, no WORLDVIEW secrets in its environment, the temporary folder removed
ok 35 - ogr2ogr host: a failure, a hang, an empty run, an oversized result and refused inputs
ok 36 - ogr2ogr host: a shapefile is its parts — an edited .dbf is a change, a .dbf linked out of the folder is refused
ok 37 - gdal-import end to end: granted folder, the host running a stand-in ogr2ogr, re-conversion only when a part changed
# tests 37
# pass 37
# fail 0
# skipped 0
```

The shared suite on two of the six examples, as the test prints it (all six: 14 pass, 0 fail):

```
gpx-diamond-head-walk (local-file)
  Config validation    PASS  ok
  Successful parse     PASS  ok
  Empty response       PASS  ok
  Malformed response   PASS  ok
  Timeout              PASS  ok
  Auth failure         PASS  ok
  Rate limit           PASS  ok
  Oversized payload    PASS  ok
  Cancellation         PASS  ok
  Mapping error        PASS  ok
  Missing fields       PASS  ok
  Attribution          PASS  ok
  Data policy          PASS  ok
  Rate policy          PASS  ok
  14 pass, 0 fail → PASS

gdal-parcels (gdal-import)
  Config validation    PASS  ok
  Successful parse     PASS  ok
  Empty response       PASS  ok
  Malformed response   PASS  ok
  Timeout              PASS  ok
  Auth failure         PASS  ok
  Rate limit           PASS  ok
  Oversized payload    PASS  ok
  Cancellation         PASS  ok
  Mapping error        PASS  ok
  Missing fields       PASS  ok
  Attribution          PASS  ok
  Data policy          PASS  ok
  Rate policy          PASS  ok
  14 pass, 0 fail → PASS
```

Identity and wording, before handing off: both commits are authored and committed by
`the-x1x1 <connersalt123@outlook.com>` with no trailers, and the handbook's two wording checks
(the commit-message grep and the repository-wide `git grep`) print `0` and nothing.

Merged into `develop` at `a5244b5` (2026-09-23) after the four amendments landed at
`6d5f29e`; the commit after the merge removed the shims, moved the examples up and moved the
host's tests into the runtime.
