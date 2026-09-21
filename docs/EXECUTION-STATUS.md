# Execution status

Current milestone: **Wave 2 — vertical slice through history/render/shell**

## Completed
- GEV audit, migration matrix (90 rows), legal inventories (37 software / 54 provider / 65 asset records), UPSTREAM.md
- Frozen contracts: world-model, provider-sdk, render-core, ipc-contract (tag `architecture-contract-v1`)
- core (logging/redaction, resilience, HttpClient), identity, hot-spatial-index, state-engine, source-health, provider-runtime
- providers/usgs end to end into world state; `pnpm provider:test usgs` 16/16 PASS; 34 tests passing
- ADR-001…012, PRODUCT-BOUNDARIES.md

## In progress
- history-store, offline (worldpacks, local search), event/query engines, render adapters, React shell, Electron shell, remaining providers

## Blocked (external)
- REMOTE_ACCESS_REQUIRED: this build session cannot reach registry.npmjs.org or provider hosts (org egress policy); Electron/Cesium/MapLibre/DuckDB cannot be installed or executed here. Verification of those packages happens on the operator's Windows machine or once egress is allowed.
- REMOTE_ACCESS_REQUIRED: git push to github.com/the-x1x1/oneview refused by the session git proxy (repo not attached to the session). Repo is delivered as a git bundle to C:\Users\temp\worldview.
- SIGNING_REQUIRED: no Windows code-signing certificate (updater stays check-only).
- AUTH_REQUIRED: NASA FIRMS MAP_KEY, AISStream key, TomTom key not available (providers ship AUTH_REQUIRED).
- LICENSE_REVIEW_REQUIRED: see docs/legal/COMMERCIAL-DISTRIBUTION-REVIEW.md blocker list (LR-01…LR-19).

## Next integration
- history-store + timeline backend behind the USGS slice; render-core → render-cesium/maplibre adapters; desktop shell bootstrap

## Known failures
- none in the current test set (artifacts/verification/tests/all.json)

## Latest verified commit
- see `git log -1` on develop; evidence under artifacts/verification/
