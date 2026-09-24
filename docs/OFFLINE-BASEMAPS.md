# Offline basemaps

The 2D map draws vector tiles in the Protomaps basemap schema (`earth`, `water`, `roads`,
`places`, `boundaries`, …) with WORLDVIEW's own dark and light styles. Offline, those tiles
are meant to come from a PMTiles file inside an installed world pack. The app does not yet
hand that file to the map; see "Installing it". This page covers three ways to make the
tiles:

1. **Build your own extract** from OpenStreetMap data with Planetiler: `pnpm basemap:build`
   (below). You choose the region and the date of the data, and it needs nobody's server
   once you have the inputs.
2. **Cut an extract from a Protomaps daily build** with the `pmtiles` CLI and pack it with
   `pnpm worldpack build --include map --pmtiles <file>`. [OFFLINE-PACKS.md](OFFLINE-PACKS.md)
   ("Obtaining a basemap extract legally") covers this route.
3. **Serve tiles from a Martin tile server** on your own network (the last section). The
   code that reads a Martin source is in place; the app cannot select it yet (see
   "Martin in the app").

Nothing on this page fetches from OpenStreetMap's tile servers (`tile.openstreetmap.org`),
and no pack contains their tiles. Their usage policy forbids offline use and bulk fetching,
and the legal registry marks them `offlinePackAllowed: false`. The app's separate
"OpenStreetMap raster" basemap, which an operator can select, does load tiles from there.
`basemap:build` downloads nothing at all: not Java, not Planetiler, not the OSM extract and
not the profile's other inputs. You fetch each of them yourself, and the tool checks they
are there.

## 1. Building an extract with Planetiler

### What you need

| What                                             | Where it comes from                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Java 21 or newer                                 | any JDK/JRE build (Temurin, Microsoft, a Linux package)                                                                                               | Found through `--java`, then `JAVA_HOME`, then `PATH`.                                                                                                                                                                                                                                            |
| The Protomaps basemap jar                        | build it: `git clone https://github.com/protomaps/basemaps`, then in `tiles/` run `mvn clean package` → `target/protomaps-basemap-HEAD-with-deps.jar` | This is Planetiler with Protomaps' profile. A stock `planetiler.jar` writes OpenMapTiles layers, which the app's styles do not draw, so the tool refuses it. It finds the jar through `--jar`, then `ONEVIEW_PLANETILER_JAR`, then any `protomaps-basemap-*-with-deps.jar` in a `PATH` directory. |
| An OSM extract (`.osm.pbf`) covering your region | a Geofabrik download page, e.g. `https://download.geofabrik.de/north-america/us/hawaii-latest.osm.pbf`                                                | Download it yourself and pass the file with `--osm`. Pass the page you took it from with `--osm-url`: the report records that URL, and the tool never fetches it. The tool reads the bounding box in the extract's header and refuses an extract that does not meet the region.                   |
| Six profile inputs, in `<work>/data/sources/`    | listed below                                                                                                                                          | The profile reads them from there. Two of them it would download on its own if they were missing, so the tool will not start Java until all six are in place.                                                                                                                                     |

The files for `<work>/data/sources/` (`<work>` defaults to `<out>/work`):

| File                            | What it is                                            | Licence                                              | Get it from                                                              |
| ------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `natural_earth_vector.gpkg.zip` | Natural Earth vector data (low zooms)                 | public domain                                        | https://naciscdn.org/naturalearth/packages/natural_earth_vector.gpkg.zip |
| `water-polygons-split-3857.zip` | OSM water polygons (osmcoastline)                     | ODbL 1.0, © OpenStreetMap contributors               | https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip  |
| `land-polygons-split-3857.zip`  | OSM land polygons (osmcoastline)                      | ODbL 1.0, © OpenStreetMap contributors               | https://osmdata.openstreetmap.de/download/land-polygons-split-3857.zip   |
| `daylight-landcover.gpkg`       | Daylight landcover, derived from ESA WorldCover       | CC BY 4.0 (ESA WorldCover)                           | https://r2-public.protomaps.com/datasets/daylight-landcover.gpkg         |
| `qrank.csv.gz`                  | QRank: Wikidata popularity, used to rank place labels | CC0 1.0                                              | https://qrank.toolforge.org/download/qrank.csv.gz                        |
| `pgf-encoding.zip`              | Font encoding tables for label text                   | encodings CC0, fonts SIL Open Font License, code MIT | https://wipfli.github.io/pgf-encoding/pgf-encoding.zip                   |

The water and land polygon files come from osmdata.openstreetmap.de, a data download
service, not a tile server. They are whole-planet files, fetched once and reused for every
region.

### Running it

Windows PowerShell, from the repository root:

```powershell
pnpm basemap:build --region hawaii --out $HOME\Downloads\wv-build\basemaps `
  --osm $HOME\Downloads\hawaii-latest.osm.pbf `
  --osm-url https://download.geofabrik.de/north-america/us/hawaii-latest.osm.pbf `
  --jar C:\tools\protomaps-basemap-HEAD-with-deps.jar --memory 4g --dry-run
```

`--dry-run` checks Java, the jar, the six inputs, the extract and the registry record, and
prints the exact Java command. The only thing it runs is `java -version`. Run the same line
again without `--dry-run` to build.

`--region` takes a preset (`hawaii`, `japan`, `california`, `uk`, `western-europe`,
`australia-east`, `us-gulf-coast`; the same presets as `pnpm worldpack`) or
`west,south,east,north`. The region is passed to Planetiler as `--bounds`, which limits the
tiles it writes to the region, so an extract larger than the region (a whole country for
one state, say) can be used. An area that crosses the antimeridian has to be built as two
regions.

Other options: `--maxzoom` (0–15, default 15), `--memory` (Java heap, e.g. `4g`),
`--threads`, `--id` (default `basemap-<preset>`), `--name`, `--work`, `--java`,
`--map-provider` (the registry record to file the pack under), `--pmtiles-only` (stop after
the PMTiles file) and `--quiet` (do not echo Planetiler's output).

### What it does

1. Checks every prerequisite and reports all the problems together:
   - Java 21 or newer, found as above;
   - the jar, recognised by the Protomaps profile class inside it and never run to ask
     what it is;
   - the six inputs;
   - the extract, including the bounding box in its header;
   - the registry record;
   - that no `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` or `_JAVA_OPTIONS` sets a
     `planetiler.*` property. Planetiler reads such properties as arguments, and a
     `planetiler.config` file could turn downloads back on.
2. Runs Planetiler from `<work>`:
   - every input path is given explicitly;
   - `--download`, `--only_download`, `--refresh_sources`, `--refresh_<source>` for each
     of the five sources, and `--fetch_wikidata` are all set to `false`;
   - the environment it passes Java has no `PLANETILER_*` variables, which Planetiler
     would otherwise read as arguments.

   Planetiler's output goes to the console and to `<out>/<id>.planetiler.log`. Its scratch
   directory, `<work>/tmp`, is removed afterwards, whether the run succeeded or not.

3. Reads the PMTiles file that was written: its header (tile type, zoom range, bounds,
   tile count) and its metadata (vector layers, attribution). It refuses the file if it is
   not vector tiles in the Protomaps schema or holds no tiles. Otherwise it moves the file
   to `<out>/<id>.pmtiles`.
4. Builds `<out>/<id>.worldpack` with the same builder `pnpm worldpack` uses, filed under
   the registry record `osm-protomaps-planetiler`. The pack's manifest and its
   `licenses/NOTICES.md` carry that record's licence and attribution.
5. Writes `<out>/<id>.basemap-report.json`. It records:
   - the extract's path, size, SHA-256, source URL and header bounding box;
   - the Java version and the jar's SHA-256;
   - the full command and how long Planetiler took;
   - the PMTiles summary and the pack.

   The pack builder also writes `<out>/<id>.worldpack.build-report.json`.

Exit codes:

- 0 when built;
- 2 for a problem with the arguments or a missing prerequisite (only `java -version` has
  run);
- 1 when Planetiler or packing failed;
- 130 when interrupted with Ctrl-C.

A failed or interrupted build leaves the previous build's `.pmtiles` and `.worldpack` in
place; the files it wrote itself are replaced only once they are complete.

### Sizes and times

None have been measured yet. No real extract has been built with this tool; its tests run
Java and Planetiler as test doubles. The first real build's report gives the numbers for
this section: the extract's size, Planetiler's `durationMs`, `pmtiles.sizeBytes`,
`pmtiles.addressedTiles` and `pack.sizeBytes`.

### Installing it

In the app: Settings → Offline packs → Install offline pack, then choose
`<out>/<id>.worldpack`. The pack is verified and installed, and "WORLDVIEW dark" and
"WORLDVIEW light" become selectable in 2D.

**The map cannot show it yet.** The catalog's two PMTiles entries hand the renderer an
empty file path (`url: ''`, packages/render-core/src/map-providers.ts), and nothing in the
runtime or the renderer replaces it with the installed pack's file. Selecting either entry
therefore draws no basemap. Going by the renderer's code, it gives up waiting for the style
and draws the map without one; this has not been watched in a running app. This holds for
every basemap pack, including one cut from a Protomaps build. The runtime and the catalog
are frozen, so the fix is an amendment request in the phase brief: serve the enabled
pack's PMTiles file to the page and put its address in the descriptor. Once that lands,
the check is: switch to 2D, choose WORLDVIEW dark, disconnect the network, restart the
app, and pan and zoom over the region.

The full credit is in the pack's `licenses/NOTICES.md`. The credit line on the map is a
different matter: it shows the fixed text of the map-provider catalog's "WORLDVIEW dark"
and "WORLDVIEW light" entries, "© OpenMapTiles © OpenStreetMap contributors", whatever
pack supplies the tiles. That names OpenMapTiles for tiles in the Protomaps schema and
leaves out Protomaps and ESA WorldCover. The catalog is frozen code, so the fix, taking
the credit line from the installed pack's record, is an amendment request in the phase
brief.

## 2. Licences and attribution

A basemap built this way contains:

- **OpenStreetMap data**, © OpenStreetMap contributors, under the Open Database Licence
  1.0. The tiles are a _Produced Work_. Anyone who sees them must see
  "© OpenStreetMap contributors". If you redistribute a modified extract, the data stays
  under the ODbL (share-alike). WORLDVIEW's code is unaffected.
- **The Protomaps basemap profile and map design**: code BSD-3-Clause, map design CC0
  (github.com/protomaps/basemaps). Protomaps asks for credit on web maps, and a modified
  fork has to use a different name.
- **Landcover** derived from ESA WorldCover (CC BY 4.0), **Natural Earth** (public
  domain), **QRank** (CC0), and **pgf-encoding** (encodings CC0, fonts SIL Open Font
  License).

The pack is filed under the provider id `osm-protomaps-planetiler`. That record must be in
`config/licenses/providers.json` before a pack can be written; until it is, `basemap:build`
refuses to pack (it fails closed) and `--pmtiles-only` still works. The record this phase
asks the integrator to add:

```json
{
  "providerId": "osm-protomaps-planetiler",
  "name": "OpenStreetMap basemap built locally with Planetiler (Protomaps basemap profile)",
  "sourceUrl": "Operator-supplied OSM extract (e.g. download.geofabrik.de), built with github.com/protomaps/basemaps",
  "termsUrl": "https://www.openstreetmap.org/copyright",
  "license": "Data: ODbL 1.0 (© OpenStreetMap contributors); Protomaps basemap profile BSD-3-Clause, map design CC0; landcover from ESA WorldCover (CC BY 4.0); Natural Earth public domain",
  "category": "basemap",
  "plannedStatus": "optional",
  "dataPolicy": {
    "cacheAllowed": true,
    "rawPayloadRetentionAllowed": true,
    "normalizedRetentionAllowed": true,
    "redistributionAllowed": true,
    "offlinePackAllowed": true,
    "exportAllowed": true,
    "commercialUseAllowed": true,
    "attributionRequired": true,
    "attributionText": "© OpenStreetMap contributors, ODbL · Protomaps basemap (BSD-3-Clause) · Landcover: ESA WorldCover (CC BY 4.0)",
    "termsUrl": "https://www.openstreetmap.org/copyright"
  },
  "commercialReview": "approved",
  "notes": "Built by the operator with pnpm basemap:build from an OSM extract they downloaded; nothing is fetched by WORLDVIEW. ODbL share-alike applies to redistributed modified extracts. Not tile.openstreetmap.org."
}
```

Whether `commercialReview` is `approved` is the operator's decision to confirm. The data
terms are the same as those of the existing `protomaps-builds` record, which is approved.

## 3. A Martin tile server

[Martin](https://maplibre.org/martin/) serves vector tiles from PMTiles or MBTiles files or
PostGIS. To serve the extract built above on your own machine:

```sh
martin --listen-addresses 127.0.0.1:3000 /path/to/basemap-hawaii.pmtiles
```

Martin's default address is `0.0.0.0:3000`, which is every interface. Give
`127.0.0.1:3000` unless other machines should reach it. `http://127.0.0.1:3000/catalog`
lists the sources, and a source's TileJSON is at `http://127.0.0.1:3000/<source id>`.
Martin names a file source after the file, so check the catalog for the exact id.

What WORLDVIEW accepts as a Martin source (`packages/offline/src/basemaps/martin.ts`):

- **Where it may be.** A loopback address (`127.0.0.1`, `localhost`, `::1`) over http or
  https, or exactly the one host you trust (for a server on your network, e.g. a NAS). Any
  other host is accepted only over https and only under a public name, never a private
  address, `.local`/`.lan`/`.internal` name or single label. A URL with credentials, a
  query or a fragment is refused.
- **What it reads.** The source's TileJSON: tile template, zoom range, bounds, name and
  attribution. Redirects are not followed, the document is capped at 1 MiB, and the
  request times out after 10 s.
- **Where the tiles may come from.** Every tile template must use the same scheme and origin
  as the TileJSON. If Martin's TileJSON names another address (behind a proxy, say), the
  source is refused and the message names both; give WORLDVIEW the address Martin's tile
  URLs use.
- **What it must contain.** The Protomaps basemap layers (`earth`, `water`, `roads`,
  `places`, `boundaries`), because those are what the styles draw. A PostGIS table or an
  OpenMapTiles build is refused, and the refusal lists the layers it does have.
- **Credit.** The TileJSON's `attribution`, reduced to plain text with no markup left in it. If there is none, you
  have to state one. A source with no credit either way is refused.

### Martin in the app

The app does not offer a Martin basemap yet. What it needs is in code this phase may not
change, so each piece is an amendment request in
`docs/roadmap/phases/offline-basemaps.md`:

- a basemap descriptor for a vector tile template drawn with the WORLDVIEW styles (render
  contract and 2D renderer);
- a catalog entry built from the configured Martin URL (map-provider catalog and runtime
  settings);
- the loopback or trusted origin allowed in the renderer's content security policy;
- `export * from './basemaps/martin.js'` in `packages/offline/src/index.ts`.

The last is needed because the package exports only its index, so nothing outside it can
call `readMartinBasemap` or `listMartinSources` until then.
