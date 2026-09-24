# Phase `offline-basemaps` — Planetiler/Protomaps extracts and a Martin tile source

Status: open · Branch: `phase/offline-basemaps` · Target: 0.2.0 · Owner: (unassigned)

## Goal

An operator can build their own basemap extract for a region with Planetiler (or download
a Protomaps build where the terms allow), put it in a pack, and see it offline; and can
point WORLDVIEW at a Martin tile server on their network as a basemap source. Both with the
attribution and the terms recorded, and nothing fetched from OSM's tile servers ever
(constraint).

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-007 (worldpacks); `docs/OFFLINE-PACKS.md`;
`packages/offline/src/builder.ts`, `manifest.ts`, `region-presets.ts`;
`apps/desktop/src/renderer/map-providers.ts` (pmtiles basemap); `tools/worldpack`.

## Scope

In: `tools/basemap` — `pnpm basemap:build --region <preset|bbox> --out <dir>` that
detects Planetiler (Java, the jar path from settings/PATH), never downloads it, runs it
with the OSM extract the operator provides (Geofabrik URL recorded, downloaded only with
explicit consent through the existing pack-download consent flow, or a local `.osm.pbf`),
produces a PMTiles file with the Protomaps basemap schema, and writes the pack entry with
attribution "© OpenStreetMap contributors, ODbL" and the Protomaps licence; `packages/
offline/src/basemaps/` — a `martin` basemap source: URL to a Martin server (loopback or
trusted host by the local policy; https for public), its TileJSON read for attribution and
bounds, used as a vector basemap by the renderer through the existing map-providers path
(the renderer change is small; if it is outside the owned globs, amendment request);
`docs/OFFLINE-BASEMAPS.md`.

Out: bundling extracts with the installer; terrain; raster basemaps; hosting anything.

## Deliverables

1. `tools/basemap/{package.json,src/cli.ts,src/planetiler.ts}` — requires a root script
   and a lockfile importer: **amendment request** (the integrator adds them; develop the
   tool runnable with `node --import tsx tools/basemap/src/cli.ts` meanwhile).
2. `packages/offline/src/basemaps/martin.ts` + tests (TileJSON parsing, host policy).
3. `docs/OFFLINE-BASEMAPS.md`: the Planetiler workflow end to end with sizes and times
   for a preset region, the Martin setup, the licences.
4. A pack built for one preset region, verified on the packaged Windows build offline
   (screenshots), its manifest in the evidence.
5. Changelog fragment; status and evidence.

## Definition of done

- [ ] an extract built by the tool loads offline in the app
- [ ] Martin source shows tiles from a local Martin
- [ ] the licence audit passes with the new attribution entries the integrator adds
- [ ] `phase-check` passes; all common checks green

## Amendment requests

- Root scripts `basemap:build`, lockfile importer for `tools/basemap`, tsconfig path.
  **Landed** (2026-09-24, integrator item #11): `pnpm basemap:build` runs
  `tools/basemap/src/cli.ts`; `tools/basemap/package.json` (`@worldview/tool-basemap`,
  depending on `@worldview/offline` and `@worldview/world-model`) has its lockfile importer;
  `tools/*/src` is already in the root tsconfig, and `tools/basemap/tsconfig.json` is there
  for a package-local check. The `cli.ts` in place is a placeholder that says it is not
  built and exits 2 — the phase replaces it. A new dependency (even a workspace one) needs
  the importer changed again: ask.
- Renderer: `map-providers.ts` gains a `martin` provider kind (frozen path) if the phase
  cannot express it through the existing pmtiles/tilejson path.

## Evidence

(filled in at the end)
