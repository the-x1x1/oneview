# ADR-001 — Foundation: God's Eye View as adapted source, everything else as dependencies

Status: Accepted · 2026-09-21

## Context

The directive names God's Eye View (GEV, MIT, base commit `0dbde1e3`, 2026-09-20) as the sole application foundation. The upstream audit (docs/architecture/GEV-MIGRATION-MATRIX.md, 90 rows) found reusable, DOM/Cesium-free source/records/ingestion modules and a well-tested Cesium map-source controller, but also a Google-3D-first startup path, non-commercial bundled data compiled into the bundle, ~28K lines of voice/director/cockpit code outside WORLDVIEW's scope, and renderer-owned polling loops.

## Decision

1. WORLDVIEW is a new pnpm monorepo (`worldview/`) with strict-TypeScript packages; GEV code is **adapted** module by module behind typed boundaries (ADAPT 44 / KEEP 13 / WRAP 1 / REPLACE 7 / REMOVE 15 / DEFER 9), never merged as an application shell.
2. Cesium, MapLibre, PMTiles, DuckDB, satellite.js, deck.gl (optional) are dependencies; readsb is an external process; go2rtc is an optional pinned sidecar; kepler.gl, tileserver-gl and MediaMTX are reference-only.
3. Legacy GEV JavaScript may remain JavaScript behind typed adapters (directive §14); new code is strict TypeScript.
4. The commercial baseline ships without TeleGeography cables, the Bhote Koshi pack, `cctv_ground_heights` (Google-derived), OpenSky (default-off), Google News, the ALPR layer and Google Photorealistic 3D as a default (docs/legal/COMMERCIAL-DISTRIBUTION-REVIEW.md).
5. Google Photorealistic 3D Tiles are an optional map-provider adapter only; the default 3D globe renders Cesium + Natural Earth II (bundled with Cesium, public domain) + ellipsoid terrain with zero credentials, with Esri World Imagery / Re:Earth terrain as keyless optional stacks pending legal sign-off.

## Consequences

- Fork debt is limited to the modules explicitly listed in UPSTREAM.md; upstream fixes are cherry-picked, never blind-merged.
- Anything GEV did in the browser proxy (`server/providers/*`) becomes main-process provider code behind the provider SDK.
- Tests: ~30 pure-module GEV test files are portable; ~74 source-text regression tests are not and are dropped.
