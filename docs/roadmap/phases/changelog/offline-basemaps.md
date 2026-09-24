### Added

- **Build your own offline basemap** (guide in `docs/OFFLINE-BASEMAPS.md`):
  `pnpm basemap:build --region hawaii --out <dir> --osm <file.osm.pbf>`.
  - **What it does:** takes an OpenStreetMap extract you downloaded yourself and runs
    Planetiler with the Protomaps basemap profile on it, cut to the region. The result is
    a PMTiles file in the schema the 2D styles draw, plus a world pack holding it for
    Settings → Offline packs → Install offline pack. The map does not draw a pack's
    basemap yet; the phase brief's amendment requests say what is missing.
  - **What it finds:** Java 21+ and the Protomaps basemap jar, already on the machine
    (`--java`/`JAVA_HOME`/`PATH`, `--jar`/`ONEVIEW_PLANETILER_JAR`/`PATH`). It recognises
    the jar by its contents without running it, and refuses a stock Planetiler jar, whose
    OpenMapTiles layers the styles would not draw.
  - **It downloads nothing:** not Java, not Planetiler, not the extract, not the profile's
    other inputs, and never anything from OpenStreetMap's tile servers. Every input must
    already be on disk, and an extract whose header bounding box misses the region is
    refused. Planetiler runs:
    - with every download, refresh and Wikidata switch off;
    - without `PLANETILER_*` variables or Java's option variables in its environment;
    - in a directory of its own for each run, removed when the run ends, even after
      Ctrl-C (the child is waited for).
  - **Checks:** `--dry-run` checks everything, runs only `java -version`, and prints the
    Java command. The output is checked before it is packed: vector tiles, the Protomaps
    layers, and tiles present.
  - **Report:** the file next to the pack records the extract's SHA-256 and the page it came
    from (`--osm-url`, never fetched), the Java version, the jar's SHA-256, the full
    command, how long it took and what came out.
  - **Licence:** the pack is filed under the registry record `osm-protomaps-planetiler`,
    credited "© OpenStreetMap contributors, ODbL" with the Protomaps licence (BSD-3-Clause,
    design CC0) and ESA WorldCover (CC BY 4.0) for the landcover. Until that record is in
    `config/licenses/providers.json`, packing is refused and `--pmtiles-only` builds the
    file alone.
- **Martin tile sources, read side** (`packages/offline/src/basemaps/martin.ts`). A Martin
  server's source is read through its TileJSON for the tile template, zoom range, bounds
  and attribution, and `/catalog` lists its sources.
  - Only loopback or the one host you trust may be named over http; anything else must be
    https under a public name.
  - Tile templates must keep the server's scheme and origin, redirects are not followed,
    and the document is capped at 1 MiB with a 10 s timeout.
  - A source without the Protomaps layers is refused, and the refusal names the layers it
    has; so is one that credits nobody.
  - The app cannot select a Martin basemap yet: the renderer descriptor, catalog entry, CSP
    origin and package export it needs are amendment requests.
