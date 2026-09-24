### Added

- **Build your own offline basemap** (guide in `docs/OFFLINE-BASEMAPS.md`):
  `pnpm basemap:build --region hawaii --out <dir> --osm <file.osm.pbf>`. The tool takes an
  OpenStreetMap extract you downloaded yourself and runs Planetiler with the Protomaps
  basemap profile on it, cut to the region. The result is a PMTiles file in the schema the
  2D styles draw, plus a world pack holding it, ready for Settings → Offline packs →
  Install offline pack. The tool finds Java 21+ and the Protomaps basemap jar on the
  machine (`--java`/`JAVA_HOME`/`PATH`, `--jar`/`ONEVIEW_PLANETILER_JAR`/`PATH`) and
  refuses a stock Planetiler jar, whose OpenMapTiles layers the styles would not draw.
  **It downloads nothing:** not Java, not Planetiler, not the extract, not the profile's
  other inputs, and never anything from OpenStreetMap's tile servers. Every input must
  already be on disk. Planetiler runs with every download and refresh switch off and
  without `PLANETILER_*` settings from the environment. `--dry-run` checks everything and
  prints the Java command. The output is checked before it is packed: vector tiles, the
  Protomaps layers, tiles present, and the requested area covered. The report next to the
  pack records the extract's SHA-256 and the page it came from (`--osm-url`, never
  fetched), the Java and profile versions, the full command, how long it took and what came
  out. The pack is filed under the registry record `osm-protomaps-planetiler`, credited
  "© OpenStreetMap contributors, ODbL" with the Protomaps licence (BSD-3-Clause, design
  CC0) and ESA WorldCover (CC BY 4.0) for the landcover. Until that record is in
  `config/licenses/providers.json`, packing is refused and `--pmtiles-only` builds the file
  alone.
- **Martin tile sources, read side** (`packages/offline/src/basemaps/martin.ts`): a Martin
  server's source is read through its TileJSON for the tile template, zoom range, bounds and
  attribution, and `/catalog` lists its sources. Only loopback or the one host you trust
  may be named over http; anything else must be https under a public name. Tile templates
  must stay on the server's origin, redirects are not followed, and the document is capped
  at 1 MiB with a 10 s timeout. A source without the Protomaps layers is refused and the
  refusal names the layers it has; so is one that credits nobody. The app cannot select a
  Martin basemap yet: the renderer descriptor, catalog entry and CSP origin it needs are
  amendment requests.
