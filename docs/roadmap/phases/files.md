# Phase `files` — Local files: GeoJSON, CSV, GPX, KML; GDAL import

Status: open · Branch: `phase/files` · Target: 0.2.0 · Owner: (unassigned)

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

1. `packages/connector-runtime/src/connectors/files/{local-file,gpx,kml,topojson,gdal-import}.ts`,
   `index.ts`; slot lines.
2. Parsers with no dependency: GPX and KML with the tolerant tag scanner pattern (see
   phase `ogc`; if both phases need one, the integrator promotes it in the refactor pass —
   write yours in your own directory).
3. Examples with sidecars and fixtures under `connectors/examples/files/`,
   `fixtures/connectors/files/`: one of each format; a GDAL-import example that the suite
   runs with a fixture standing in for `ogr2ogr` output.
4. `docs/connectors/files.md`: the folder grant, formats, GDAL detection, limits.
5. `files.test.ts`: suite; path-escape refusal; mtime polling; size cap; parser cases.
6. Changelog fragment; status and evidence.

## Definition of done

- [ ] `connector:test --all` green
- [ ] path policy tests (outside folder, symlink, UNC) refuse
- [ ] `phase-check` passes; all common checks green

## Design notes

- `ProviderLocalAccess.readGrantedFile` / `statGrantedFile` read the folder the user named
  (see the landed amendment below); `providers/infrastructure` shows the bundled-resources
  case, which is the same call against the fallback grant.
- KML `<coordinates>` are lon,lat[,alt] whitespace-separated triples; `<gx:Track>` has
  `<when>`/`<gx:coord>` pairs.
- GPX `<trkpt lat lon>` with `<ele>` and `<time>`; a track is one object with the last
  point as position and the whole as geometry; waypoints are objects of their own.
- A CSV without lat/lon but with an address is not geocoded (product boundary).

## Amendment requests

- **Landed** (ADR-003, 2026-09-23 amendment): declare `transport: 'filesystem'`, a `string`
  setting for the folder and `grantedFolderSetting: '<that key>'` in the manifest the
  `local-file` connector derives; read with `context.local.readGrantedFile(relativePath,
{ maxBytes })` and poll for change with `context.local.statGrantedFile?.(relativePath)`
  (size + mtimeMs) — both stay inside the folder the user named, refuse `..`, absolute
  paths outside it, directories and drive roots, and answer UNSUPPORTED while no folder is
  named (Source Health should say "name a folder in Settings"). The bundled `resources/data`
  grant applies only when the setting is empty, so a definition without a folder cannot
  read the operator's disk. No folder picker yet: the operator types the path (a "Browse…"
  control is `source-health-ui`'s or a later amendment).

## Evidence

(filled in at the end)
