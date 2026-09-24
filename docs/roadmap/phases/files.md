# Phase `files` — Local files: GeoJSON, CSV, GPX, KML; GDAL import

Status: building · Branch: `phase/files` · Target: 0.2.0 · Owner: phase agent (session 014MSZ)

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

- `ProviderLocalAccess` exposes what a provider may read; check what the SDK gives
  (`readFile`? `stat`?) and request the minimal amendment if a granted-folder read is not
  there — the `infrastructure` provider shows what exists today.
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

(filled in at the end)
