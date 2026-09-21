# Offline world packs (`.worldpack`)

Status: Release 1 · ADR-007 · Package `@worldview/offline` · CLI `pnpm worldpack`

A world pack is a portable bundle of **data only** that lets WORLDVIEW work without a
network: a basemap extract, place and airport layers, a local search index, historical
observations (earthquakes in Release 1) and the licence notices for all of it. Packs are
built on one machine with `pnpm worldpack build`, verified byte-for-byte on import and
installed under the app's data directory. Nothing in a pack is executed — ever.

## 1. Format

A `.worldpack` is a ZIP archive with a fixed layout:

| Path | Kind | Notes |
| --- | --- | --- |
| `manifest.json` | — | The `WorldPackManifest` (below). Always present; never listed in its own `contents`. |
| `maps/<name>.pmtiles` | `pmtiles` | Vector basemap extract (PMTiles v3). Stored, not deflated. |
| `data/<name>.geojson` | `geojson` | Place / airport / infrastructure layers (FeatureCollection of Point features, flat properties). |
| `data/<name>.ndjson` | `ndjson` | History rows (`HistoryRow`, one JSON object per line), e.g. `data/earthquakes.ndjson`. |
| `data/<name>.parquet` | `parquet` | Reserved for the DuckDB history backend. |
| `search/index.json` | `search-index` | Serialized `PlaceIndex` (entries only; postings are rebuilt on load). |
| `licenses/NOTICES.md` | `notices` | Attribution and licence text for every source in the pack. Exactly one. |

**Allowed files.** The manifest schema enforces the path pattern per kind
(`CONTENT_PATH_RULES`), so a pack can only carry files the app knows how to treat.
Independently, the ZIP reader refuses entry names that are not
`[A-Za-z0-9._-]` segments joined by `/`, and any name ending in an executable or script
extension (`.exe .dll .js .mjs .cjs .ps1 .bat .cmd .sh .vbs .scr .com .msi .jar .py .lnk
.hta .wsf .pif .so .dylib .wasm .reg .app`). Names with `..`, `.`, hidden segments,
backslashes, drive letters, absolute paths, Windows device names, directory entries or
non-ASCII characters are rejected.

**Container limits.** Zip32 only (no zip64: any entry, or the archive, above 4 GiB is
refused), methods STORE and DEFLATE only, no encryption, no multi-disk, no data after the
end record, no prepended data (self-extracting stubs). Defaults: 2 GiB per entry,
8 GiB total declared size, 4096 entries, deflate ratio at most 200:1.

## 2. Manifest

```jsonc
{
  "formatVersion": 1,
  "id": "hawaii",                       // kebab-case; also the install directory name
  "name": "Hawaiian Islands",
  "version": "1.0.0",                   // optional, semver
  "createdAt": "2026-09-21T12:00:00.000Z",
  "expiresAt": "2027-09-21T00:00:00.000Z",   // optional; expired packs still load but are flagged
  "geographicBounds": { "west": -161, "south": 18.5, "east": -154.5, "north": 22.5 },
  "contents": [
    { "path": "maps/hawaii.pmtiles", "kind": "pmtiles", "sizeBytes": 71234567, "sha256": "…", "providerId": "protomaps-builds" },
    { "path": "data/places.geojson", "kind": "geojson", "sizeBytes": 7165, "sha256": "…", "providerId": "worldview-seed-places", "objectType": "place", "rowCount": 26 },
    { "path": "data/earthquakes.ndjson", "kind": "ndjson", "sizeBytes": 2194, "sha256": "…", "providerId": "usgs-earthquakes", "objectType": "earthquake", "rowCount": 5 },
    { "path": "search/index.json", "kind": "search-index", "sizeBytes": 5450, "sha256": "…", "rowCount": 31 },
    { "path": "licenses/NOTICES.md", "kind": "notices", "sizeBytes": 766, "sha256": "…" }
  ],
  "sourcePolicies": [
    { "providerId": "protomaps-builds", "license": "ODbL 1.0 (© OpenStreetMap contributors)", "attribution": "Protomaps · © OpenStreetMap contributors (ODbL)", "offlinePackAllowed": true, "redistributionAllowed": true, "termsUrl": "https://docs.protomaps.com/" }
  ],
  "minimumAppVersion": "0.1.0",
  "checksums": { "maps/hawaii.pmtiles": "…", "data/places.geojson": "…", "…": "…" }
}
```

The schema (`worldPackManifestSchema`, built from the world-model `s` combinators) is
strict: unknown keys are rejected, every content path must match its kind, `checksums`
must list exactly the content paths with the same digests, every `providerId` used by a
content entry must have a `sourcePolicies` record, every policy record must be used, both
`offlinePackAllowed` and `redistributionAllowed` must be `true`, and exactly one
`licenses/NOTICES.md` is required.

## 3. Source-policy checks (fail closed)

Every layer in a pack is attributed to a provider id. The builder resolves the provider's
`ProviderDataPolicy` (from `config/licenses/providers.json`, the legal registry, plus the
bundled seed fixtures under `worldview-seed-places` / `worldview-seed-airports`, MIT) and
refuses the **whole build** when:

- no policy is registered for the provider (unknown licence is treated as *not allowed*),
- `offlinePackAllowed` is false,
- `redistributionAllowed` is false (a pack is something you can hand to another machine),
- `attributionRequired` is true but no attribution text is declared.

`mayIncludeInWorldpack(policy)` from `@worldview/provider-sdk` is the single rule. The
same flags are copied into `sourcePolicies`, so an importing app can re-check them, and
`licenses/NOTICES.md` is rendered from the policies' attribution text. Examples from the
registry: `usgs-earthquakes`, `protomaps-builds`, `natural-earth` are allowed;
`openfreemap`, `esri-world-imagery`, `google-maps-platform`, `celestrak`
(`redistributionAllowed: false`) are refused.

## 4. Integrity verification on import

`verifyWorldPack(file)` / `extractWorldPack(file, dir)` run these steps in order and stop
at the first failure — nothing is inflated before the entry table has been validated:

1. **Structure.** Locate the end-of-central-directory record, reject zip64 markers,
   multi-disk archives, trailing or prepended data, and a central directory that does not
   fit the declared entry count.
2. **Entry table.** For every central-directory record: safe name (§1), no duplicates
   (case-insensitive), no encryption flags, method STORE/DEFLATE only, no symlink mode in
   the external attributes, sizes within the per-entry and total caps, deflate ratio
   ≤ 200:1, and the entry's data must lie before the central directory.
3. **Manifest.** Read `manifest.json` (≤ 4 MiB) and validate it against the strict schema.
4. **Cross-check.** The set of archive entries (minus the manifest) must equal the set of
   manifest content paths; declared sizes must agree; `minimumAppVersion` must be
   satisfied; `expiresAt` produces a warning.
5. **Data.** Each entry is inflated through a bounded stream (aborting the moment the
   output exceeds the declared size), the local header is compared with the central
   record (name, method, sizes), CRC-32 is checked against the ZIP header and SHA-256
   against `manifest.checksums`.

Extraction writes into a staging directory (`worldpacks/.staging/<random>/`); only when
every check passed is it renamed atomically to `worldpacks/<id>/`. A failed import leaves
nothing behind. The adversarial test set (`packages/offline/src/zip.test.ts`,
`manifest.test.ts`, `registry.test.ts`) covers zip-slip names, symlink attributes,
oversize and lying sizes, tampered checksums, executable entries, manifest/entry
mismatches, compression-bomb ratios, truncated files, encryption and zip64 markers.

## 5. Building a pack

```
pnpm worldpack regions                       # list presets
pnpm worldpack build --region hawaii --include map,places,airports,earthquakes \
    --pmtiles hawaii.pmtiles --history-dir "%APPDATA%/WorldView" --out hawaii.worldpack
pnpm worldpack build --bbox -161,18.5,-154.5,22.5 --include places,airports
pnpm worldpack build --center 21.3,-157.9 --radius-km 150 --include places
pnpm worldpack verify hawaii.worldpack
pnpm worldpack inspect hawaii.worldpack [--json]
```

Options: `--places <geojson>` and `--airports <geojson>` default to the bundled seed
fixtures (`fixtures/places`, `fixtures/airports`); `--days N` sets the earthquake window
(default 365); `--id`, `--name`, `--version`, `--min-app`, `--report` override the
defaults; `--map-provider <id>` records a different provider for the PMTiles file (it
must pass the policy check). The build writes `<out>.build-report.json` with every
entry's size, digest and row count, the clipped feature counts per layer and the
attribution that went into `NOTICES.md`.

Region presets (bounds only): `hawaii`, `japan`, `california`, `uk`, `western-europe`,
`australia-east`, `us-gulf-coast`.

### Obtaining a basemap extract legally

Protomaps publishes daily planet builds of OpenStreetMap-derived vector tiles under the
ODbL. Use the `pmtiles` CLI (https://docs.protomaps.com/pmtiles/cli) to cut a regional
extract — only the tiles inside the bounding box are downloaded:

```
pmtiles extract https://build.protomaps.com/20260920.pmtiles hawaii.pmtiles --bbox=-161,18.5,-154.5,22.5
pmtiles extract https://build.protomaps.com/20260920.pmtiles japan.pmtiles --bbox=122.5,24,146.5,46 --maxzoom=12
```

Pick the build date from https://maps.protomaps.com/builds/. The extract's data is
© OpenStreetMap contributors under the ODbL 1.0; the registry record `protomaps-builds`
carries the required credit ("Protomaps · © OpenStreetMap contributors (ODbL)") which
the app shows on the map whenever the pack's tiles are visible and which the builder
writes into `NOTICES.md`. Share-alike applies to modified extracts you redistribute.
Do **not** bulk-download tiles from OpenFreeMap or tile.openstreetmap.org for packs —
their policies forbid it and the registry marks them `offlinePackAllowed: false`.

The builder checks the PMTiles v3 magic header before packing and stores the file
uncompressed (PMTiles tiles are already gzip/brotli-compressed internally).

### Earthquake history

`--include earthquakes` reads `earthquake` rows from the app's history store
(`--history-dir` = the WorldView data directory; DuckDB/Parquet when available, NDJSON
otherwise), clipped to the pack bounds and to the last `--days` days, and writes them as
`data/earthquakes.ndjson` (one file per provider when several contributed). Rows keep
their provenance; the registry serves them as `origin: 'historical'` objects.

## 6. Importing and using a pack in the app

`WorldPackRegistry` (`@worldview/offline`) backs the IPC channels `offline.status`,
`offline.installPack`, `offline.removePack` and `offline.setPackEnabled`:

- `install(file)` → verify + extract to staging + atomic rename into
  `<dataDir>/worldpacks/<id>/` (replacing a pack with the same id).
- `list()` reads every installed manifest, validates it and checks that the files exist
  with the manifest's sizes; a broken pack is listed as `status: 'invalid'` with a message,
  never dropped silently. `verifyInstalled(id)` re-hashes everything on demand.
- `setEnabled(id, bool)` and `remove(id)` update `worldpacks/state.json`.
- `capabilities()` → `{ localMap, localSearch, history, collections, localAircraft }`:
  `localMap` when an enabled pack carries a PMTiles file, `localSearch` when the merged
  place index is non-empty, the rest from flags the runtime injects.
- `pmtilesPaths()` for the MapLibre/Cesium adapters, `dataFiles(kind, objectType)` for the
  query engine, `placeIndex()` for `search.query` (results are `source: 'worldpack'`).

`ConnectionMonitor` folds the OS online flag, an optional reachability probe and the
`SourceHealthRegistry` snapshot into `CONNECTED / DEGRADED / OFFLINE` with hysteresis
(two agreeing evaluations before a probe- or source-driven change; an OS "offline" signal
applies immediately). `pnpm test:offline` builds a Hawaii pack from the seed fixtures,
installs it into a temporary data directory with `WORLDVIEW_NETWORK=off` and every fetch
disabled, and records the proof in
`artifacts/verification/offline/worldpack-build-report.json` (regenerated by each run; not tracked).

## 7. Local search

`PlaceIndex` is a pure-TypeScript inverted index over normalized tokens (lowercase,
diacritics and ʻokina stripped, punctuation collapsed) with prefix matching. Ranking:
airport code match > exact name > name prefix > token overlap, plus an importance boost
and an optional distance bias toward the caller's position. The serialized form
(`search/index.json`, `formatVersion: 1`) holds the entries only; postings are rebuilt at
load. Packs are merged by entry id (first installed wins). SQLite FTS5 is the planned
upgrade behind the same interface (ADR-007).

## 8. Limits and non-goals

- No terrain in packs: 3D offline uses the ellipsoid; 2D offline uses the PMTiles basemap.
- No code, no scripts, no styles: the app ships its own basemap style.
- No signing yet: integrity is SHA-256 per file; authenticity (who built the pack) is a
  Release 2 item alongside the update trust model (ADR-012).
