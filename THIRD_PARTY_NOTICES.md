# Third-party notices — WORLDVIEW

This file lists the third-party software bundled in WORLDVIEW and the data providers whose data WORLDVIEW displays, with the licence and copyright notice each requires. It is generated from [`config/licenses/software.json`](config/licenses/software.json), [`config/licenses/providers.json`](config/licenses/providers.json) and [`config/licenses/assets.json`](config/licenses/assets.json) (seed version 2026-09-21; **regenerate from the release lockfile before every build** — see `docs/legal/SOFTWARE-LICENSES.md` §3).

Licence identifiers are SPDX. Full licence texts for Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT and OFL-1.1 are shipped in the `LICENSES/` directory of the installed application; the MIT and BSD-3-Clause texts are also reproduced below because several notices require them verbatim. Where a copyright holder could not be confirmed from package metadata in this environment it is marked **(verify)** and must be completed before release.

Reading this file does not change any licence: WORLDVIEW's own code is proprietary; each component below remains under its own terms.

---

## Part A — Software

### A.1 Adapted source

#### God's Eye View — MIT

WORLDVIEW's application foundation is derived from God's Eye View (https://github.com/bilawalsidhu/gods-eye-view), commit `0dbde1e36c0177b7664b47702d77ba50f11ddadc`. The MIT grant covers the source code only; God's Eye View's bundled datasets and 3D models are third-party works listed in Parts B and C.

```
MIT License

Copyright (c) 2026 Bilawal Sidhu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### skylight — MIT

Portions of the aircraft classification, icon, motion, route-plausibility and ISS-pass logic in WORLDVIEW were adapted by God's Eye View from skylight (https://github.com/cpaczek/skylight), MIT License. Copyright (c) skylight contributors **(verify exact copyright line from upstream LICENSE)**. The MIT permission notice above applies.

### A.2 Bundled runtime components

| Component                                                           | Licence      | Copyright notice                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron                                                            | MIT          | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. Electron also redistributes Chromium (Copyright The Chromium Authors, BSD-3-Clause) and Node.js (Copyright Node.js contributors, MIT) whose complete notices are shipped as `LICENSE.electron.txt` and `LICENSES.chromium.html` in the application resources. |
| electron-updater                                                    | MIT          | Copyright (c) 2015 Loopline Systems **(verify)**                                                                                                                                                                                                                                                                                       |
| React, React DOM                                                    | MIT          | Copyright (c) Meta Platforms, Inc. and affiliates.                                                                                                                                                                                                                                                                                     |
| CesiumJS (`cesium`, `@cesium/engine`, `@cesium/widgets`)            | Apache-2.0   | Copyright 2011-present CesiumJS Contributors. CesiumJS incorporates third-party code (including draco, earcut, knockout, mersenne-twister, protobuf and others) listed in its `LICENSE.md`; that section is reproduced in `LICENSES/cesium-LICENSE.md`.                                                                                |
| MapLibre GL JS                                                      | BSD-3-Clause | Copyright (c) 2023 MapLibre contributors; Copyright (c) 2020 Mapbox. MapLibre's `LICENSE.txt` lists further bundled third-party code and is reproduced in `LICENSES/maplibre-gl-LICENSE.txt`.                                                                                                                                          |
| PMTiles (`pmtiles`)                                                 | BSD-3-Clause | Copyright (c) 2021 Protomaps LLC **(verify year)**                                                                                                                                                                                                                                                                                     |
| DuckDB (`@duckdb/node-api`, `@duckdb/node-bindings`, DuckDB engine) | MIT          | Copyright (c) Stichting DuckDB Foundation / DuckDB Labs **(verify)**. DuckDB's `LICENSE` covering its `third_party/` directory is reproduced in `LICENSES/duckdb-LICENSE`.                                                                                                                                                             |
| satellite.js                                                        | MIT          | Copyright (c) 2013 Shashwat Kandadai and UCSC **(verify)**                                                                                                                                                                                                                                                                             |
| egm96-universal                                                     | MIT          | Copyright (c) egm96-universal authors **(verify — repository and holder not present in package metadata)**. Embeds the NGA EGM96 geoid grid, a U.S. Government work in the public domain.                                                                                                                                              |
| mgrs                                                                | MIT          | Copyright (c) proj4js contributors **(verify)**                                                                                                                                                                                                                                                                                        |
| pbf                                                                 | BSD-3-Clause | Copyright (c) 2017, Mapbox                                                                                                                                                                                                                                                                                                             |
| @mapbox/vector-tile                                                 | BSD-3-Clause | Copyright (c) 2014, Mapbox                                                                                                                                                                                                                                                                                                             |
| @mapbox/point-geometry                                              | ISC          | Copyright (c) 2015, Mapbox                                                                                                                                                                                                                                                                                                             |
| Material Symbols (self-hosted subset)                               | Apache-2.0   | Copyright Google LLC                                                                                                                                                                                                                                                                                                                   |
| Inter (self-hosted, if used)                                        | OFL-1.1      | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)                                                                                                                                                                                                                                                               |
| JetBrains Mono (self-hosted, if used)                               | OFL-1.1      | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)                                                                                                                                                                                                                                         |
| Noto Sans Regular (2D label glyphs, `fonts/`)                       | OFL-1.1      | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic). Glyph ranges via protomaps/basemaps-assets; the OFL text ships beside them as `fonts/OFL.txt`.                                                                                                                                            |

### A.3 Optional components (present only in builds or installations that include them)

| Component                                                                            | Licence      | Copyright notice                                                           | When present                |
| ------------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------- | --------------------------- |
| h3-js                                                                                | Apache-2.0   | Copyright Uber Technologies, Inc. (NOTICE reproduced if adopted)           | candidate                   |
| rbush, quickselect                                                                   | MIT / ISC    | Copyright (c) 2016 Vladimir Agafonkin                                      | candidate                   |
| deck.gl, luma.gl, loaders.gl, math.gl                                                | MIT          | Copyright (c) 2015-present Uber Technologies, Inc. and vis.gl contributors | not in Release 1            |
| gtfs-realtime-bindings                                                               | Apache-2.0   | Copyright Google LLC / MobilityData **(verify)**                           | candidate                   |
| protobufjs                                                                           | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz                                           | with gtfs-realtime-bindings |
| ws                                                                                   | MIT          | Copyright (c) 2011 Einar Otto Stangvik                                     | if used by the AIS provider |
| go2rtc (separate binary, downloaded at the user's request; never bundled by default) | MIT          | Copyright (c) 2022 Alexey Khit **(verify)**                                | optional sidecar            |

**Not distributed with WORLDVIEW:** readsb (GPL-3.0, https://github.com/wiedehopf/readsb) is a separate program the user may install; WORLDVIEW only reads its network output and includes no readsb code. Build-time tools (Vite, esbuild, TypeScript, tsx, electron-builder, vite-plugin-cesium) are not part of the installed application.

### A.4 Licence texts required verbatim

**BSD-3-Clause** (pbf, @mapbox/vector-tile, MapLibre GL JS, PMTiles, protobufjs):

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

**MIT** — the permission notice reproduced under God's Eye View above applies, with the respective copyright line, to every MIT component listed.

**Apache-2.0** (CesiumJS, Material Symbols, optionally h3-js and gtfs-realtime-bindings): the full licence is shipped as `LICENSES/Apache-2.0.txt` (https://www.apache.org/licenses/LICENSE-2.0). Components' NOTICE files, where they exist, are reproduced in `LICENSES/`.

**OFL-1.1** (fonts): the full licence is shipped as `LICENSES/OFL-1.1.txt` beside the font files.

---

## Part B — Bundled third-party works (not software)

### B.1 3D models — Creative Commons Attribution 4.0 (CC BY 4.0), modified

The following models are shipped with WORLDVIEW under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Each was optimised by God's Eye View (geometry and material simplification, texture resizing, orientation and scale baked into the mesh, origin centred) and is used here in that modified form. These credits do not imply endorsement by the original creators.

| File            | Original work                                      | Creator              | Source                                                                                                          |
| --------------- | -------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `airplane.glb`  | "boeing 747"                                       | zairiq-123           | https://sketchfab.com/3d-models/boeing-747-9b16672038ba48f98e6d80a159044ed9                                     |
| `jet.glb`       | "Private Jet"                                      | Nick the Name        | https://sketchfab.com/3d-models/private-jet-cbdd1de6ced9461e950eafaa302cc82b                                    |
| `ship.glb`      | "Low Poly Cargo Ship"                              | Javier_Fernandez     | https://sketchfab.com/3d-models/low-poly-cargo-ship-4c22cbaf01c1427f8ab60b3a07b1b32c                            |
| `bell206.glb`   | "Bell 206 JetRanger"                               | terran4627           | https://sketchfab.com/3d-models/bell-206-jetranger-d2f7ba1d671549d4b26aaf834139a1dd                             |
| `c172.glb`      | "Cessna 172"                                       | e737                 | https://sketchfab.com/3d-models/cessna-172-64cddaee5aff470682659a8c08525046                                     |
| `citation2.glb` | "1990 Cessna Citation, Texture Detailed, Exterior" | BlenderCommunityHead | https://sketchfab.com/3d-models/1990-cessna-citation-texture-detailed-exterior-a78839624fe64900a8352cb23462350a |
| `mq9.glb`       | "MQ-9"                                             | IProZenoN            | https://sketchfab.com/3d-models/mq-9-fabe963feb354c5584b51f9c470c3f7e                                           |
| `b789.glb`      | "Boeing 787-9"                                     | Nobilis 2            | https://sketchfab.com/3d-models/boeing-787-9-b6711e2e698e4e469675c1154a50b7a3                                   |
| `atr72.glb`     | "ATR 72 - 600"                                     | Oyan3D               | https://sketchfab.com/3d-models/atr-72-600-1e1a7186f7444d288675262fcee44744                                     |

The per-model modification record is shipped as `THIRD_PARTY_MODELS.md`.

### B.2 Bundled datasets

| Dataset                                                    | Licence       | Notice                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenStreetMap datacenter features (4,351)                  | ODbL 1.0      | © OpenStreetMap contributors — https://www.openstreetmap.org/copyright. This derived database is made available under the Open Database License (https://opendatacommons.org/licenses/odbl/1-0/). |
| Open Infrastructure Map / OpenStreetMap dam features (704) | ODbL 1.0      | © OpenStreetMap contributors; source credit: Open Infrastructure Map. Same ODbL notice.                                                                                                           |
| Natural Earth 10m physical regions and marine polygons     | Public domain | Made with Natural Earth (https://www.naturalearthdata.com/).                                                                                                                                      |
| Natural Earth country and state borders and label points   | Public domain | Made with Natural Earth (https://www.naturalearthdata.com/). The borders-and-names layer (`reference/`).                                                                                          |
| DataSF "Analysis Neighborhoods" (41 polygons)              | PDDL 1.0      | City & County of San Francisco — DataSF (https://data.sfgov.org/).                                                                                                                                |
| NGA EGM96 geoid grid (inside egm96-universal)              | Public domain | National Geospatial-Intelligence Agency.                                                                                                                                                          |

---

## Part C — Data attribution

WORLDVIEW displays data fetched at runtime from the providers below. Each provider's data remains subject to that provider's terms; WORLDVIEW does not license it. The attribution shown in the application's credit line and stamped on exports is listed here. Providers marked _when enabled_ are off by default and appear only once the user configures them.

### C.1 Default providers

| Provider                                                                           | Attribution                                                                                                                                           | Terms                                                                             |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| U.S. Geological Survey — earthquakes                                               | Earthquakes: data courtesy of the U.S. Geological Survey                                                                                              | Public domain                                                                     |
| CelesTrak — satellite element sets                                                 | Satellite element sets: CelesTrak (celestrak.org), Dr. T.S. Kelso                                                                                     | Citation requested                                                                |
| adsb.lol — aircraft positions                                                      | Aircraft positions: adsb.lol contributors (ODbL 1.0)                                                                                                  | https://github.com/adsblol/globe_history                                          |
| Local receiver (readsb)                                                            | Local receiver (readsb) — user's own data                                                                                                             | —                                                                                 |
| OpenFreeMap — vector basemap                                                       | OpenFreeMap · © OpenMapTiles · Data from OpenStreetMap contributors (ODbL)                                                                            | https://openfreemap.org/                                                          |
| Protomaps — offline basemap extracts                                               | Protomaps · © OpenStreetMap contributors (ODbL)                                                                                                       | https://docs.protomaps.com/                                                       |
| Re:Earth Terrain / Mapterhorn — terrain                                            | Re:Earth Terrain · Mapterhorn (CC BY 4.0) · EGM2008 (NGA)                                                                                             | https://terrain.reearth.land/                                                     |
| OpenStreetMap via Overpass, Photon (komoot), Nominatim — features and place search | © OpenStreetMap contributors (ODbL 1.0); Photon (komoot)                                                                                              | https://www.openstreetmap.org/copyright                                           |
| Fintraffic / Digitraffic — road cameras (Finland)                                  | Fintraffic / digitraffic.fi, license CC BY 4.0                                                                                                        | https://www.digitraffic.fi/en/terms-of-service/                                   |
| Transport for NSW — Live Traffic cameras                                           | Live Traffic NSW — Transport for NSW (CC BY 4.0)                                                                                                      | https://opendata.transport.nsw.gov.au/                                            |
| Transport for London — JamCams                                                     | Powered by TfL Open Data. Contains OS data © Crown copyright and database rights                                                                      | https://tfl.gov.uk/info-for/open-data-users/                                      |
| Ontario 511 — highway cameras                                                      | Contains information licensed under the Open Government Licence – Ontario                                                                             | https://www.ontario.ca/page/open-government-licence-ontario                       |
| DriveBC — highway cameras                                                          | DriveBC. Contains information licensed under the Open Government Licence – British Columbia (plus per-camera partner credits as supplied by the feed) | https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc      |
| Open Calgary — traffic cameras                                                     | Contains information licensed under the Open Government Licence – City of Calgary                                                                     | https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa             |
| Hong Kong Transport Department — traffic snapshots                                 | Transport Department, the Government of the Hong Kong SAR — DATA.GOV.HK                                                                               | https://data.gov.hk/en/terms-and-conditions                                       |
| Vegagerðin (IRCA) — road webcams (Iceland)                                         | Based on information provided by the Icelandic Road and Coastal Administration (IRCA)                                                                 | https://www.vegagerdin.is/vegagerdin/gagnasafn/vefthjonustur/terms-and-conditions |
| QLDTraffic — Queensland traffic cameras                                            | QLDTraffic — State of Queensland (Department of Transport and Main Roads), CC BY 4.0 AU                                                               | https://qldtraffic.qld.gov.au/more/Developers-and-Data/                           |
| Entur — Norway transit vehicles                                                    | Entur — data under NLOD                                                                                                                               | https://data.norge.no/nlod/en/2.0                                                 |
| TransLink — South East Queensland transit vehicles                                 | TransLink — Queensland Government (CC BY 4.0)                                                                                                         | https://translink.com.au/about-translink/open-data                                |
| HSL — Helsinki transit vehicles                                                    | HSL (Helsinki Region Transport), CC BY 4.0                                                                                                            | https://www.hsl.fi/en/hsl/open-data                                               |
| MBTA / MassDOT — Boston transit vehicles                                           | MBTA / MassDOT                                                                                                                                        | MassDOT Developers License Agreement                                              |
| CapMetro — Austin transit vehicles                                                 | Capital Metropolitan Transportation Authority — data.texas.gov                                                                                        | https://www.capmetro.org/developertools                                           |
| OVapi / Stichting OpenGeo — Netherlands transit vehicles                           | OVapi / Stichting OpenGeo — Dutch integrated real-time transit data (NDOV)                                                                            | https://gtfs.ovapi.nl/README                                                      |

### C.2 Providers shown when enabled by the user

| Provider                                                                                                                                                                                                                                                                                             | Attribution                                                                                                                                                                                                                       | Terms                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| NASA FIRMS — active fires (user MAP_KEY)                                                                                                                                                                                                                                                             | We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth Observing System Data and Information System (EOSDIS). | https://firms.modaps.eosdis.nasa.gov/                                                 |
| AISStream.io — vessels (user API key)                                                                                                                                                                                                                                                                | Vessels: AISStream.io                                                                                                                                                                                                             | https://aisstream.io/documentation                                                    |
| Open-Meteo — weather (commercial API key)                                                                                                                                                                                                                                                            | Weather data by Open-Meteo.com (CC BY 4.0)                                                                                                                                                                                        | https://open-meteo.com/en/terms                                                       |
| NOAA National Weather Service — alerts                                                                                                                                                                                                                                                               | Alerts: NOAA National Weather Service                                                                                                                                                                                             | Public domain                                                                         |
| TomTom — traffic flow (user API key)                                                                                                                                                                                                                                                                 | Traffic flow data © TomTom                                                                                                                                                                                                        | https://developer.tomtom.com/legal                                                    |
| Esri — World Imagery                                                                                                                                                                                                                                                                                 | Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community                                                                                                                                          | https://www.esri.com/en-us/legal/terms/full-master-agreement                          |
| Cesium ion — terrain and imagery (user token)                                                                                                                                                                                                                                                        | Cesium ion and per-asset data-provider credits as rendered by the CesiumJS credit display                                                                                                                                         | https://cesium.com/legal/terms-of-service/                                            |
| Google Maps Platform — Photorealistic 3D Tiles (user API key)                                                                                                                                                                                                                                        | Google / Google Maps logo as rendered by the tileset credit; must remain visible                                                                                                                                                  | https://cloud.google.com/maps-platform/terms                                          |
| GBFS bikeshare operators                                                                                                                                                                                                                                                                             | Operator name and licence link as published in each feed's `system_information.json`                                                                                                                                              | per feed                                                                              |
| Trafikverket — Swedish road cameras (user API key)                                                                                                                                                                                                                                                   | Trafikverket (Swedish Transport Administration), CC0 1.0                                                                                                                                                                          | https://www.trafikverket.se/e-tjanster/trafikverkets-oppna-api-for-trafikinformation/ |
| Metro Transit (Metropolitan Council), City of Austin, Texas DOT, Caltrans, NYC DOT, Iowa DOT, City of Tallinn, Transpordiamet / Tarktee, Stadt Warendorf — courtesy camera and transit feeds (Caltrans, Austin, NYC and Iowa cameras: the `public-cameras-unverified` source, licence not confirmed) | "<Provider name> (courtesy)" as recorded in `config/licenses/providers.json`                                                                                                                                                      | pending review; off by default                                                        |

### C.3 Not included

WORLDVIEW does not include TeleGeography Submarine Cable Map data (CC BY-NC-SA 3.0), the Vantor / GeoPera Bhote Koshi 2026 event pack (CC BY-NC 4.0), OpenSky Network data (non-commercial licence; provider disabled unless the user holds their own agreement), Google News RSS, adsbdb route data, the OpenStreetMap ALPR camera layer, Google-derived precomputed camera heights, or God's Eye View's documentation media, all of which are present in the upstream God's Eye View repository under terms that do not permit inclusion in this product.
