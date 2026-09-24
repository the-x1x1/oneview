# Local files: `local-file` and `gdal-import`

A file on the operator's disk is a source. `local-file` reads GeoJSON, CSV, GPX, KML and
TopoJSON itself; `gdal-import` hands anything else GDAL reads — a shapefile, a GeoPackage, a
File Geodatabase — to the operator's own `ogr2ogr` and reads the GeoJSON it writes. Both
look at the file's modification time on every poll and read it again only when it changed.

> **Status (phase `files`).** The connectors, their readers and their tests are complete, but
> three frozen contracts do not yet carry what a file source needs, so this build refuses
> every file definition with a message that says why. The phase's brief
> ([files.md](../roadmap/phases/files.md)) requests the amendments: **A1** the definition
> keeps its `file` block (ADR-013), **A2** the host grants the folder named in the source's
> `folder` setting and can stat a file in it (ADR-003), **A3** the host runs `ogr2ogr`
> (ADR-003), **A4** the shared suite serves its fixture as the file (ADR-013). Until they
> land, the examples live in `connectors/examples/files/awaiting-amendments/` and run the
> shared suite through the phase's shim in `files.test.ts`.

## The folder

A file source reads from one folder, and only from it. The folder is the operator's: they
name it in the source's **Folder** setting (`folder`, which the connector adds to every file
source's settings), and the host grants exactly that folder to exactly that source. Nothing
is discovered and no other folder is ever read.

The definition names the file _inside_ the folder, with `/` separators:

```json
"file": { "path": "gps/diamond-head-walk.gpx" }
```

Two checks keep the path inside the folder, and both must pass:

1. **The connector's**, when the definition is validated and before every read. Refused:
   absolute paths (`/x`, `\x`), drive letters (`C:`), UNC and device paths
   (`\\server\share`, `//server`, `\\?\`, `\\.\`), any `:` (URLs, alternate data streams),
   `..`, `~`, empty segments, control characters, `<>"|?*`, a segment ending in a dot or a
   space (Windows strips those, so two names would reach one file) and the Windows device
   names (`CON`, `NUL`, `COM1`…).
2. **The host's**, on the real file system: the folder's and the file's real paths — links,
   junctions and shortcuts resolved by the operating system — are compared, so a link that
   leads out of the folder is refused however it is spelt. Only regular files are read (a
   named pipe would block the poll forever).

A network share is fine as the granted folder itself — it is a path the operator chose.
What a definition cannot do is name a share, or anything else, from inside its `file.path`.

## The `file` block

| Field             | Meaning                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `path`            | The file inside the granted folder (required).                                                                                                               |
| `format`          | `geojson`, `csv`, `gpx`, `kml` or `topojson`. Default: from the extension; a `.json` file is TopoJSON or GeoJSON by what it holds. `gdal-import` takes none. |
| `intervalSeconds` | How often the modification time is looked at. Default 30, at least 5.                                                                                        |
| `maxBytes`        | The largest file read. Default 16 MiB, at most 64 MiB; the host's own cap (32 MiB) applies as well.                                                          |
| `layers`          | TopoJSON: the objects to read (default every object). `gdal-import`: the layers to convert (default the only one).                                           |

`endpoint`, `websocket`, `boundsQuery` and credentials do not apply to a file and are refused
or ignored with a warning; `mapping`, `freshness`, `attribution`, `sourceQuality`, `settings`
and the data policy work as for every connector ([OVERVIEW.md](OVERVIEW.md)). A file
definition is `review: "user-configured"`: its data policy stays fail-closed.

## Polling

On each poll the provider asks the host for the file's size and modification time. The same
answer as last time: the observations it already has are served again, unchanged (same ids),
and nothing is read. A different answer: the file is read, decoded, parsed and mapped. The
file is looked at again after the read; if it changed while it was being read the result is
served but not remembered, and a parse failure in that case is retried on the next poll
rather than reported as a bad file. A poll asked for within five seconds of the last look is
answered from memory without looking.

Records whose own data carries no time are dated by the file's **modification time** — when
the file last said so — and flagged `file-time`; the poll's own time would make an unchanged
file look new every 30 seconds. Set `freshness` to how long the file's content stays true: a
year for reference data, a day for a GPS log.

## Formats

GPX, KML and TopoJSON become GeoJSON-shaped features, so one mapping vocabulary covers
every format. Beside `properties` each feature has `id`, `kind`, `name`, `description`,
`time` (ISO 8601) and, where the position is not the geometry's first coordinate, `point`.
When a definition names neither `mapping.position` nor `mapping.geometry`, the position is
`point` (falling back to the geometry's first coordinate) and the geometry is drawn whole.
GPX and KML also default `observedAt` to `time` and label records by `name`.

**GeoJSON** — a FeatureCollection (its `features`) or a single Feature; `response.itemsPath`
reads records elsewhere. Coordinates must be longitude/latitude (RFC 7946): a file that still
declares another `crs` (EPSG:3857, a state plane) is refused with that reason — convert it, or
read it with `gdal-import`, which reprojects.

**CSV** — the `csv` connector's reader and options (`response.csv`: delimiter, header,
columns). The definition must map `position` from latitude and longitude columns: **an address
is never geocoded**, and a row with only an address is rejected with a reason.

**GPX** (1.0 and 1.1) — a waypoint is a Point; a route is a line through its route points (a
plan, so no time); **a track is one object**: its geometry is the whole track (a
MultiLineString when it has several segments), its position the last point and its time that
point's time, with `pointCount`, `segmentCount`, `lengthM`, `startTime` and `endTime` in its
properties. Ids are `waypoint-<n>`, `route-<n>`, `track-<n>` in file order, so map
`externalId` to `name` instead if the names are unique and the order changes. Times without
a zone are UTC, as GPX says; a point with a bad latitude or longitude is left out of its track
and counted (`invalidPoints`).

**KML** (2.2) — every Placemark, however deeply foldered; `folder` is the enclosing Folder's
name. Point, LineString, LinearRing, Polygon (with holes), MultiGeometry, `gx:Track`,
`gx:MultiTrack` (last point and time, as a GPX track) and Model. A MultiGeometry of one kind
becomes a Multi\* geometry; a mixed one (a polygon with its label point) keeps the polygon as
the geometry and the point as the position, with `mixedGeometry: true`. `ExtendedData` (`Data`
and `SchemaData`) becomes string properties — type them with `number` in the mapping.
`<address>` is kept as text and never geocoded. A **NetworkLink is not followed**: a file
source reads the file it names and nothing it points to. KMZ (a zip) goes through
`gdal-import`.

**TopoJSON** — arcs decoded (delta-decoded and scaled when quantized), shared arcs joined, a
negative index reversed; every object or those `file.layers` names, a GeometryCollection's
geometries each a record. The id is the geometry's `id`, else `<object>-<n>`; `kind` is the
object's name. A projected topology is refused rather than drawn in the wrong place.

**Text** — a byte-order mark decides (UTF-8, UTF-16); then, for GPX and KML, the XML
declaration's encoding; then strict UTF-8. A file that is not UTF-8 and names nothing is read
as Windows-1252 (what spreadsheet programs on Windows write) and the log says so.

The XML reader is a tolerant tag scanner with no dependency: it forgives an unquoted
attribute, a stray end tag or an element left open at the end of the file, and refuses a file
with no root element or a tag that never closes. A DOCTYPE and its entities are skipped, never
expanded.

## `gdal-import`

```json
"connector": "gdal-import",
"file": { "path": "gis/parcels/parcels.shp", "intervalSeconds": 300 },
"mapping": { "externalId": "properties.PARCEL_ID" }
```

GDAL is **never bundled, installed or downloaded**. The host looks for `ogr2ogr` on `PATH`
(`ogr2ogr.exe` on Windows — OSGeo4W, QGIS and conda all install one; its `bin` folder must be on the `PATH` WORLDVIEW starts with) and logs the version it
found. Without it the source is OFFLINE, "ogr2ogr was not found … install GDAL to import …",
and looks again every five minutes.

The host runs, with no shell, a minimal environment (no WORLDVIEW secrets reach GDAL) and a
fresh temporary folder that is always removed:

```
ogr2ogr -f GeoJSON -t_srs EPSG:4326 -lco RFC7946=YES <temporary>/out.geojson <dataset> [<layer>]
```

and the output is read as a GeoJSON `local-file` would read it. GDAL's GeoJSON writer holds one
layer, so several `file.layers` are converted one at a time and merged; their ids are
prefixed with the layer (`roads-12`) and each record says its `layer`. A conversion runs only
when the dataset changed — the newest modification time and total size over its files: a
shapefile's `.shp`, `.shx`, `.dbf`, `.prj` and `.cpg`, or the files directly inside a `.gdb`
folder — so editing only the attribute table is seen.

Accepted: `.shp`, `.gpkg`, `.gdb` (a folder), `.fgb`, `.tab`, `.mif`, `.dxf`, `.sqlite`, `.kmz`,
`.geojsonl`, `.geojsons`. **Refused by name**: `.vrt`, `.xml`, `.gml`, `.ovf`, `.gfs`,
`.xlsx`, `.ods` — formats that can point at other files or network locations, which would
read outside the granted folder; a dataset part that is a link out of the folder is refused
too. The formats `local-file` reads are sent there.

## Limits

- A file: 16 MiB unless `file.maxBytes` says otherwise (at most 64 MiB), and the host's 32 MiB.
  Over it is TOO_LARGE, known from the size before a byte is read.
- 50,000 records per read (the connector SDK's cap); a line or ring of more than 100,000
  points is skipped with a reason (the world model's limit).
- XML: 2,000,000 elements, 256 levels deep. A description is kept to 4,096 characters.
- A conversion: 120 seconds.

## What a file source never does

Write a file; watch a whole folder (a later `discovery` phase); follow a NetworkLink, a VRT or
any other reference; geocode an address; read raster formats; install or download anything.

## Examples

`connectors/examples/files/awaiting-amendments/` (moved up one level when A1 and A4 land):

| Example                          | Format                  | Shows                                                                                                  |
| -------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `gpx-diamond-head-walk.json`     | GPX                     | a track as one object at its last point, a route, waypoints, a bad waypoint rejected                   |
| `kml-reef-survey.json`           | KML                     | folders, ExtendedData, a polygon with a hole, a mixed MultiGeometry, a gx:Track, a NetworkLink ignored |
| `csv-rain-gauges.json`           | CSV                     | latitude/longitude/elevation columns; an address-only row rejected, not geocoded                       |
| `geojson-community-gardens.json` | GeoJSON                 | polygons drawn whole; records dated by the file (`file-time`)                                          |
| `topojson-districts.json`        | TopoJSON                | two districts sharing an arc, a point object, a null geometry skipped                                  |
| `gdal-parcels.json`              | shapefile via `ogr2ogr` | the suite's fixture stands in for ogr2ogr's output                                                     |

The fixtures are invented in each format's published shape, not recordings
([fixtures README](../../fixtures/connectors/README.md)).
