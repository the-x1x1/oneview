# WORLDVIEW — Bundled asset provenance

Status: **draft for legal review** · Generated 2026-09-21 · Machine-readable twin: [`config/licenses/assets.json`](../../config/licenses/assets.json) (schema `worldview/licenses/assets/v1`, 65 records)

Every file GEV ships that is _not_ ordinary MIT source code — 3D models, event imagery, bundled datasets, icons, curated camera catalogs, test fixtures, documentation media — with its provenance, licence and a decision:

- **bundle** — goes into the WORLDVIEW repository and/or installer with the attribution recorded here.
- **exclude** — not imported (licence, privacy, branding or simply no value).
- **review** — importable in principle but a human must confirm something first.

Sizes are the byte sizes in the GEV clone at commit `0dbde1e3`. Sources: GEV `public/models/README.md`, `public/events/bhote-koshi-2026/README.md`, `src/data/local_data/*/README.md|SOURCE.md`, `docs/media/README.md`, GEV `LICENSE`, GEV-AUDIT-NOTES.md §(e), GEV-MIGRATION-MATRIX.md rows 39, 44, 81-87.

## 1. Decision summary

| Decision | Files | Bytes (approx)                                                                                        |
| -------- | ----- | ----------------------------------------------------------------------------------------------------- |
| bundle   | 22    | 9.4 MB (3.3 MB models, 6.1 MB datasets, READMEs/fixtures)                                             |
| exclude  | 37    | 77.4 MB (70.3 MB docs media, 3.5 MB TeleGeography + Bhote Koshi, 2.0 MB Google-derived heights, misc) |
| review   | 6     | 0.2 MB                                                                                                |

## 2. Bundle

### 2.1 3D models — CC BY 4.0 (Sketchfab), modified by GEV

| File                          | Size    | Original work                                      | Creator                                                     | Licence   |
| ----------------------------- | ------- | -------------------------------------------------- | ----------------------------------------------------------- | --------- |
| `public/models/airplane.glb`  | 88,144  | "boeing 747"                                       | [zairiq-123](https://sketchfab.com/zairiq-123)              | CC BY 4.0 |
| `public/models/jet.glb`       | 270,988 | "Private Jet"                                      | [Nick the Name](https://sketchfab.com/Nick_The_Name)        | CC BY 4.0 |
| `public/models/ship.glb`      | 230,024 | "Low Poly Cargo Ship"                              | [Javier_Fernandez](https://sketchfab.com/Javier.Fernandez)  | CC BY 4.0 |
| `public/models/bell206.glb`   | 320,788 | "Bell 206 JetRanger"                               | [terran4627](https://sketchfab.com/terran4627)              | CC BY 4.0 |
| `public/models/c172.glb`      | 526,088 | "Cessna 172"                                       | [e737](https://sketchfab.com/e0057537)                      | CC BY 4.0 |
| `public/models/citation2.glb` | 562,036 | "1990 Cessna Citation, Texture Detailed, Exterior" | [BlenderCommunityHead](https://sketchfab.com/aboodgoudagad) | CC BY 4.0 |
| `public/models/mq9.glb`       | 542,880 | "MQ-9"                                             | [IProZenoN](https://sketchfab.com/IProZenoN)                | CC BY 4.0 |
| `public/models/b789.glb`      | 470,200 | "Boeing 787-9"                                     | [Nobilis 2](https://sketchfab.com/nobilishornet2)           | CC BY 4.0 |
| `public/models/atr72.glb`     | 263,948 | "ATR 72 - 600"                                     | [Oyan3D](https://sketchfab.com/oyan3D)                      | CC BY 4.0 |
| `public/models/README.md`     | 4,929   | attribution table                                  | GEV                                                         | MIT (doc) |

CC BY 4.0 permits commercial use and adaptation provided the credit, a licence link and a **modification notice** are retained ("These credits do not imply endorsement by the original creators" — README line 19-21). GEV's modifications (geometry/material simplification, 256 px WebP textures, Y-up / nose −X baking, origin centring) are documented per model. Obligations for WORLDVIEW:

1. Ship `public/models/README.md` verbatim beside the models (as `THIRD_PARTY_MODELS.md`) and reproduce it in `THIRD_PARTY_NOTICES.md` (done).
2. Surface the nine credits in Help → About / Credits.
3. If WORLDVIEW modifies a model further, extend the modification notice; do not drop GEV's.
4. Sketchfab model pages are the canonical source URLs; record them, since Sketchfab licences can be changed by the uploader later (the licence at download time governs, and the README is the evidence).

### 2.2 Bundled datasets

| File                                                                 | Size      | Licence       | Attribution                                            | Notes                                                                                                                      |
| -------------------------------------------------------------------- | --------- | ------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `src/data/local_data/datacenters/datacenters.geojsonl` (+ README)    | 2,561,978 | ODbL 1.0      | © OpenStreetMap contributors                           | 4,351 features; contact tags stripped; **extraction query/date not recorded** — re-extract with provenance before release. |
| `src/data/local_data/dams/dams.geojsonl` (+ README)                  | 730,280   | ODbL 1.0      | © OpenStreetMap contributors · Open Infrastructure Map | 704 features. Ship the JSONL only.                                                                                         |
| `src/data/local_data/natural_earth/regions.json` (+ README)          | 1,987,099 | Public domain | Made with Natural Earth (courtesy)                     | 1,046 named regions; nvkelso/natural-earth-vector `ca96624a`, fetched 2026-07-28.                                          |
| `src/data/local_data/natural_earth/marine.json`                      | 633,342   | Public domain | Made with Natural Earth (courtesy)                     | 292 marine polygons.                                                                                                       |
| `src/data/local_data/neighborhoods/san-francisco.json` (+ SOURCE.md) | 222,167   | PDDL 1.0      | City & County of San Francisco — DataSF (courtesy)     | 41 polygons; retrieved 2026-07-30; reproducible via `scripts/build-sf-neighborhoods.mjs`.                                  |

### 2.3 Test fixtures (repo only, not in the installer)

| File                                              | Size  | Licence                                | Notes              |
| ------------------------------------------------- | ----- | -------------------------------------- | ------------------ |
| `src/data/fixtures/firms-viirs-noaa20-sample.csv` | 3,962 | NASA FIRMS — US Government / open data | 45 rows.           |
| `src/data/fixtures/firms-csv-cases.json`          | 1,482 | MIT (GEV-authored)                     | Parser edge cases. |

### 2.4 Notice text

| File            | Size  | Notes                                                                    |
| --------------- | ----- | ------------------------------------------------------------------------ |
| `LICENSE` (GEV) | 3,281 | MIT text + carve-out. Reproduced in `THIRD_PARTY_NOTICES.md`; must ship. |

## 3. Exclude

### 3.1 Non-commercial data

| File                                                                | Size          | Licence                                                    | Why                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/data/local_data/telegeography_submarine_cables/cable-geo.json` | 728,308       | CC BY-NC-SA 3.0                                            | NonCommercial. Downloaded 2026-05-24 from submarinecablemap.com API v3.                                                                                                                                                                                                                                                                              |
| `…/landing-point-geo.json`                                          | 359,269       | CC BY-NC-SA 3.0                                            | NonCommercial.                                                                                                                                                                                                                                                                                                                                       |
| `…/source.json`, `…/README.md`                                      | 1,113 / 1,460 | MIT (manifest/doc)                                         | Go with the folder.                                                                                                                                                                                                                                                                                                                                  |
| `public/events/bhote-koshi-2026/pre.webp`                           | 1,353,906     | CC BY-NC 4.0                                               | Vantor WorldView-2 scene `10300100C86CED00` crop.                                                                                                                                                                                                                                                                                                    |
| `public/events/bhote-koshi-2026/post.webp`                          | 1,004,808     | CC BY-NC 4.0                                               | Vantor WorldView-3 scene `B040001100881410` crop.                                                                                                                                                                                                                                                                                                    |
| `public/events/bhote-koshi-2026/event.json`                         | 42,175        | CC BY-NC 4.0 (centerline); linked posts keep owners' terms | GeoPera reconstruction subset + 16 evidence records.                                                                                                                                                                                                                                                                                                 |
| `public/events/bhote-koshi-2026/README.md`                          | 3,735         | MIT (doc)                                                  | Goes with the pack.                                                                                                                                                                                                                                                                                                                                  |
| **`src/data/bhoteKoshiFloodPath.js`**                               | 19,468        | **CC BY-NC 4.0 data inside a `.js` file**                  | GEV LICENSE lines 41-48: "The derived coordinates remain third-party data even though they are embedded in a JavaScript source file". Deleting `public/events/` alone is insufficient — delete `src/data/bhoteKoshi*.js`, `src/scenes/packs/nepal.js`, `src/scenes/nepalEvidencePack.js` and their catalog/layerState registrations (matrix row 39). |

### 3.2 Google-derived data

| File                                                                          | Size      | Why                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/data/local_data/cctv_ground_heights/cctv_ground_heights.json` (+ README) | 1,991,265 | `provider: "google-3d-tiles"`: heights sampled from Google Photorealistic 3D Tiles for 3,445 cameras. Google Maps Content "may not be cached, stored, rehosted, or committed" (DATA_SOURCES.md line 63). Regenerate from Re:Earth/Mapterhorn (CC BY 4.0) if precomputed heights are wanted. |

### 3.3 Branding, removed features, synthetic configs

| File                                                  | Size    | Why                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/logo.svg`                                     | 8,434   | GEV's brand identity. MIT on the bytes does not make another product's logo usable; trademark/passing-off risk.                                                                                                                                    |
| `public/mic.svg`                                      | 498     | Voice feature removed.                                                                                                                                                                                                                             |
| `config/cctv_sources.austin.json`                     | 3       | Empty array.                                                                                                                                                                                                                                       |
| `config/cctv_sources.shinjuku.json`                   | 1,658   | Three _fake_ Tokyo cameras whose `url` points at Google's public sample-video bucket (`gtv-videos-bucket/sample/*.mp4`, licence of the bucket not stated). Misleading in a product; replace with a WORLDVIEW-owned sample clip for pipeline tests. |
| `scripts/fixtures/voice/full-globe-turn-on-radio.wav` | 884,274 | Recording of a human voice with no stated consent/licence; voice feature removed.                                                                                                                                                                  |
| `src/data/local_data/dams/dams.geojson`               | 730,321 | Duplicate of the JSONL. Not a licence issue.                                                                                                                                                                                                       |

### 3.4 Documentation media (19 files + README, 70 MB)

`docs/media/*.gif`, `docs/media/start-here/*.gif`, `docs/media/youtube-popular-videos.png`, `docs/media/open-source-survey.png`, `docs/media/README.md`.

`docs/media/README.md` is explicit: "Copyright © Bilawal Sidhu. These files are not covered by the project's MIT License. Permission is limited to their inclusion and redistribution with this repository and its project documentation. No permission is granted for standalone reuse or modification. Commercial reuse outside this repository requires separate permission." The captures also show Google Photorealistic 3D Tiles and third-party data layers. **Do not import** (matrix row 87). Individual records with sizes are in `assets.json`.

## 4. Review

| File                                                   | Size    | Question for the reviewer                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/pin.svg`                                       | 489     | Path geometry and style (24-viewBox, stroke-2, round caps) match the **Lucide "pin"** icon (ISC). GEV credits nobody. Either add the Lucide/Feather notice (ISC/MIT permit commercial use with notice) or replace with the WORLDVIEW icon set. Not a blocker. |
| `public/location.svg`                                  | 325     | Matches **Feather "map-pin"** (MIT) / Lucide. Same as above.                                                                                                                                                                                                  |
| `public/visual-presets.svg`                            | 351     | Resembles **Feather "layers"** (MIT). Same as above; the visual-presets feature itself is deferred.                                                                                                                                                           |
| `config/cctv_sources.tallinn.json`                     | 172,173 | GEV-authored (MIT) pose catalog for 255 City of Tallinn cameras. Harmless on its own but only useful once the `tallinn-ristmikud` provider clears manual review. Convert to a pack manifest with a `license` field (matrix row 81).                           |
| `config/cctv_sources.warendorf.json`                   | 757     | Same, for one Warendorf webcam; heading derived from OSM geometry (ODbL — keep the OSM credit). Plain-HTTP source URL is also a security item.                                                                                                                |
| `src/data/fixtures/tomtom-flow-austin-12-935-1686.pbf` | 22,980  | One captured TomTom flow tile (© TomTom), test-only, never served. Committing it to a commercial repo is a small redistribution of TomTom content. Keep only with legal OK (matrix row 85); otherwise synthesise a fixture.                                   |

## 5. Things that are _not_ assets but look like them

- `src/locations.js` `CITY_POIS` (hand-authored city/POI presets with elevations) — GEV MIT code; keep (audit §(e)).
- Material Symbols, Inter, JetBrains Mono — not in the GEV repo (loaded from Google Fonts CDN at runtime). WORLDVIEW will bundle them locally; they are tracked in `SOFTWARE-LICENSES.md` / `software.json`, not here.
- The EGM96 geoid grid — inside the `egm96-universal` npm package (public domain data, MIT wrapper); tracked in `software.json` and `providers.json` (`nga-egm-geoid`).
- `.gev-cache/` — gitignored runtime cache; never committed, never an asset.
