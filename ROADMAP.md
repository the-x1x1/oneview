# Roadmap

Versions describe capability, not marketing. Nothing is held back from a release to
make a label fit (directive §126).

## 0.1.0 — Foundation (current)

Windows desktop, canonical world model, provider SDK and runtime, ten providers, 3D and
2D renderers, search, lenses, selection and context, history and timeline, offline
packs, collections, watch zones, source health, diagnostics, credential storage,
updater architecture, CI and release tooling.

## 0.2.0 — Offline everywhere

Bundled basemap extracts for common regions; pack signing; incremental pack updates;
offline terrain where a compatible source is legally clear; SQLite FTS place index at
country scale; pack management UI (size, coverage, freshness, update).

## 0.3.0 — Historical world

Longer retention with tiered downsampling in DuckDB/Parquet as the default backend;
replay of multi-day windows; per-object history views (track playback, altitude and
speed profiles); "what changed" as a first-class screen; export of historical queries
where the source policy permits.

## 0.4.0 — Event intelligence

Richer deterministic correlation (aftershock sequences, fire growth, storm tracks,
alert supersession); event timelines and relationships; watch-zone rules with quiet
hours and escalation; a world feed that ranks by relevance rather than recency.

## 0.5.0 — Local sensor ecosystem

First-class local sources beyond readsb and cameras: AIS SDR, weather stations, NMEA
devices, Meshtastic/LoRa, environmental sensors; a local-sensor SDK with the same
manifest/data-policy contract; device discovery that stays conservative and explicit.

## 0.6.0 — Provider extensions

Third-party providers as installable packages — only once signing, a permission model,
process isolation and a review process exist (directive §128). A provider registry and
a `worldview provider scaffold` CLI.

## 1.0.0 — Stable baseline

Code signing and low-friction updates; macOS and Linux; ARM64; accessibility audit;
performance budgets enforced in CI; documented data-retention defaults reviewed by
legal; the commercial distribution review closed with no outstanding blockers.

## Deliberately not planned

Named-person search, facial recognition, deanonymisation, private-device tracking,
plate-history databases, camera-frame analysis. See
[docs/PRODUCT-BOUNDARIES.md](docs/PRODUCT-BOUNDARIES.md).
