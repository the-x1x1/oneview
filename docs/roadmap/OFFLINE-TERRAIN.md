# Offline terrain — a source to choose (0.3.0)

Status: **a decision for the operator.** Nothing here is bundled or switched on. Written
2026-10-05 for ROADMAP 0.3.0 "Offline terrain where a compatible source is legally clear: a
source to be chosen and reviewed first", and ADR-007 ("3D offline = ellipsoid, or a local
terrain adapter when legally available").

## Where things stand

- Online, the globe can already draw Re:Earth's quantized-mesh terrain, built from
  **Mapterhorn** (`reearth-terrain-mapterhorn` in `config/licenses/providers.json`:
  `commercialReview: approved`, `offlinePackAllowed: true`, attribution required). Its notes
  say offline packs "should carry Mapterhorn PMTiles downloaded from Mapterhorn, not scraped
  from the Re:Earth endpoint", and that per-source credit is still to be verified.
- Offline, the globe is the smooth ellipsoid (KNOWN-LIMITATIONS; OFFLINE-PACKS.md "No terrain
  in packs").

## The candidate: Mapterhorn's own PMTiles

What Mapterhorn publishes (mapterhorn.com/data-access and github.com/mapterhorn/mapterhorn,
read 2026-10-05):

- Terrarium-encoded elevation as WebP tiles 512 px wide, in PMTiles archives:
  `planet.pmtiles` for zoom 0–12, and regional archives (named like `6-33-22.pmtiles`) for
  zoom 13–17. Served from `download.mapterhorn.com` and mirrors; also tile by tile from
  `tiles.mapterhorn.com/{z}/{x}/{y}.webp`. A region is cut from the planet file with the
  `pmtiles extract` tool (protomaps/go-pmtiles).
- Code: BSD-3. Data: "various open-data sources", listed in
  `download.mapterhorn.com/attribution.json`.

### The sources and their licences (attribution.json, read 2026-10-05)

About 115 entries. The global base is **Copernicus DEM GLO-30** (30 m); the rest are national
and regional surveys, mostly in Europe, plus Australia, Canada, Japan, New Zealand, Rwanda,
Taiwan and Israel. Grouped by licence (counts approximate — the list was summarised, not
transcribed):

| Licence                                                                                       | Sources    | Note                                               |
| --------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------- |
| CC BY 4.0 (and "Creative Commons Attribution 4.0")                                            | ~65        | attribution to each licensor                       |
| Licence Ouverte / Open Licence 2.0 (France, IGN)                                              | ~19        | attribution                                        |
| Datenlizenz Deutschland – Namensnennung 2.0                                                   | ~9         | attribution                                        |
| Datenlizenz Deutschland – Zero 2.0                                                            | 3          | none                                               |
| CC0 / CC Zero                                                                                 | ~6         | none                                               |
| Open Government Licence (UK; Canada)                                                          | 3          | attribution                                        |
| Other open-government licences (Taiwan, Poland, Switzerland, Faroe Islands, Romania, Estonia) | ~7         | attribution; each its own text                     |
| CC BY 3.0 (Tasmania), CC BY 2.5 (Trentino)                                                    | 2          | attribution                                        |
| ASTER GDEM public domain (Israel 10 m)                                                        | 1          | none                                               |
| **Japan GSI content terms** (国土地理院コンテンツ利用規約)                                    | 6          | **custom — to be read**                            |
| **Flanders "model licence for free reuse"**                                                   | 1          | **custom — to be read**                            |
| **Copernicus GLO-30**                                                                         | 1 (global) | free, commercial use allowed; fixed notice (below) |

No non-commercial, no-derivatives or share-alike licence was found in the list. Two are not
standard licences and should be read before a pack covering Japan or Flanders is shipped.

Copernicus DEM (dataspace.copernicus.eu, COP-DEM, read 2026-10-05): GLO-30 and GLO-90 "are
available worldwide with a free license". Distributing modified data requires the notice
"produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space
GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved".
Armenia, Azerbaijan and Moldova, once withheld, were released in the 2023_1 delivery.

### What crediting it would take

A pack covering only the sea and Copernicus-only land (Hawaii, most of the Americas, Africa
and Asia) needs Mapterhorn's credit and the Copernicus notice. A pack over Europe also needs
the credit of each survey under it. Two ways to do that, for the operator to choose:

1. **By area**: the pack builder reads attribution.json, keeps the sources whose coverage
   meets the pack's bounds, and writes their credits into the pack (shown with the terrain
   while it is drawn, and in the About/attribution dialog). Needs each source's coverage,
   which attribution.json may not carry — to check.
2. **All of them**: every pack with terrain carries the whole list, shown in the attribution
   dialog, with "Terrain: Mapterhorn and its sources (see Attribution)" on screen.

### Heights

Mapterhorn's heights appear to be above the geoid: Re:Earth credits EGM2008 for the mesh it
serves as "ellipsoid", which suggests it adds the geoid to them (to confirm on a real tile).
The globe expects heights above the ellipsoid; the two differ by −106 m to +85 m. Drawn as is,
the ground would sit up to ~100 m too high or low against aircraft altitudes and orbits — not
against objects clamped to the ground. A coarse public-domain geoid grid (NGA EGM96 or
EGM2008, already recorded as `nga-egm-geoid`) bundled beside it would correct this to a few
metres; 1° spacing is about 130 KB.

## How it would be drawn (not built)

No new dependency: the globe would read the pack's PMTiles with the `pmtiles` library the 2D
map already uses for pack basemaps, decode each WebP tile with the browser's own image
decoder, turn Terrarium colours into heights (`R × 256 + G + B / 256 − 32768` metres), add the
geoid, and hand Cesium a heightmap per tile (Cesium's `CustomHeightmapTerrainProvider` with a
Web-Mercator tiling scheme, so a terrain tile is a Mapterhorn tile). Past the pack's deepest
zoom the deepest tile is resampled. Packs would gain an optional `terrain` entry (a PMTiles
file, its encoding, zoom range and credits) beside the basemap, checked when the pack is
installed like the rest of it.

Size: the planet to zoom 12 is the archive Mapterhorn names `planet.pmtiles`; a state-sized
extract to zoom 12 is tens of megabytes (to measure on a real extract before promising one).

## Alternatives considered

- **AWS Terrain Tiles / Tilezen Joerd** (Terrarium PNG, 256 px): mixed sources (SRTM, GMTED,
  ETOPO1 and national data) with their own attribution list; Mapterhorn describes itself as
  the successor and moved from 256 px to 512 px tiles.
- **Copernicus GLO-90 or GLO-30 alone**: one notice, global, but the pack builder would have to
  make the tiles from GeoTIFFs (GDAL), and Europe would lose its finer national surveys.
- **NOAA ETOPO 2022** (public domain, 15″/30″/60″): one source, no attribution burden, bathymetry
  included — but about 500 m at best: a relief for the globe from afar, not terrain close in.
- **Cesium World Terrain**: an ion token and Cesium's terms; not for offline packs.

## The decision needed

1. Is Mapterhorn the source for terrain in worldpacks (the register already approves it
   offline), and is the GLO-30 notice acceptable as written?
2. Crediting: by area or all of them?
3. Japan's GSI terms and the Flanders licence: read them first, or keep packs over those areas
   without terrain until then?
4. Bundle a coarse geoid grid (NGA, public domain) for the heights, or accept the offset?

Until these are answered the globe stays smooth offline.
