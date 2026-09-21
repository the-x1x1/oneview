# ADR-007 — Offline world packs (.worldpack)

Status: Accepted · 2026-09-21 · Package: `@worldview/offline`, `tools/worldpack`

## Decision
- A `.worldpack` is a ZIP-container of **data only**: `manifest.json`, `maps/*.pmtiles`, `data/*.parquet|*.geojson`, `search/index.json`, `licenses/NOTICES.md`. Never code. The manifest (`WorldPackManifest`) declares bounds, contents, per-source policies (`offlinePackAllowed` must be true for every included source), minimum app version and SHA-256 checksums for every file.
- Import validates: archive structure, no path traversal, no absolute paths, no symlinks, no executable extensions, per-file and total decompression limits, manifest schema, checksums — fail closed.
- Builder CLI: `pnpm worldpack build --region hawaii --include map,places,airports,earthquakes` (presets, bbox, radius, source selection). Sources whose policy forbids redistribution are refused.
- Offline terrain is not implied by PMTiles: 3D offline = ellipsoid (or a local quantized-mesh terrain adapter when legally available); 2D offline = full PMTiles/MapLibre map.
- Local place search uses a pure-TS inverted index (`search/index.json`) in Release 1; SQLite FTS5 is the planned upgrade behind the same `PlaceIndex` interface.

## Consequences
Offline claims are proven by `pnpm test:offline` with `WORLDVIEW_NETWORK=off` (remote providers must report OFFLINE, packs load, local search answers "Honolulu").
