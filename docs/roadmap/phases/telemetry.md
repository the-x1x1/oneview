# Phase `telemetry` — Telemetry series and a Readings panel (Open MCT harvest)

Status: open · Branch: `phase/telemetry` · Target: 0.2.0 · Owner: (unassigned)

## Goal

A sensor's values over time — temperature from a weather station, PM2.5 from an air
monitor, battery from a tracker, a reading pushed through ingest — plotted in the object's
context panel, following the timeline, with units and limits from a descriptor that is
data. The design is [OPENMCT-HARVEST.md](../../architecture/OPENMCT-HARVEST.md).

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); OPENMCT-HARVEST.md; ADR-005 (history) and
`packages/history-store`; `apps/desktop/src/renderer/context/` (sections, `track-history.tsx`
and `track-profile.ts` are the nearest existing things: altitude/speed profiles for aircraft);
`docs/architecture/UI.md` (tokens, panel patterns).

## Scope

In: `packages/telemetry` — `TelemetryDescriptor { series: [{ key, name, units, format?,
min?, max?, limits?: { warnLow?, warnHigh?, critLow?, critHigh? } }] }` validated (capped at
32 series), resolved for an object from (a) its provider's definition `telemetry` block
(connector definitions; requires the ADR-013 amendment to carry it — until then, a per-object-type
default table in the package), (b) a per-object-type default (weather-station:
temperature, humidity, pressure, wind; sensor: whatever numeric keys are present, unnamed);
a projection `readings(objectId, key, window) → [t, v][]` over the history store through
the existing IPC (no new IPC unless the amendment says so — check `history.*` requests);
`apps/desktop/src/renderer/context/readings.tsx`: a Readings section — one series as an
SVG line, several stacked, timeline-following, units, limit bands, latest value; empty
state says "no readings in this window".

Out: a charting dependency; alerting from limits (a later watch-zone rule); composite
displays.

## Deliverables

1. `packages/telemetry/{package.json,tsconfig.json,src/…}` — requires a `tsconfig.base.json`
   path and a lockfile importer: **amendment request** (the integrator adds the package
   stub first; build against it).
2. Descriptor schema and tests; projection and tests with history fixtures.
3. The Readings section registered in the context registry for `weather-station`,
   `sensor`, and any object whose provider carries a descriptor.
4. `docs/connectors/telemetry.md` (the `telemetry` block for definitions, the defaults).
5. Changelog fragment; status and evidence (screenshots of the panel on the packaged app).

## Definition of done

- [ ] descriptor validation and projection tests green
- [ ] the panel renders against fixture history in a renderer test
- [ ] shown on the packaged Windows build for a weather station and a PurpleAir sensor
- [ ] `phase-check` passes; all common checks green

## Design notes

- The history store keeps observations; a series is `payload[key]` over `observedAt` for one
  object — downsample to at most 2,000 points per series for the panel (min/max buckets, as
  the track profile does).
- Units: keep SI in payloads; the descriptor's `units` is display only, and `format`
  is one of a fixed set (`number:1`, `percent`, `hpa`, `celsius`, …), not a format string.

## Amendment requests

- **Package stub: landed** (integrator item #8). `packages/telemetry` exists with its
  `package.json` (depends on provider-sdk and world-model), `tsconfig.json`, the
  `tsconfig.base.json` path, the lockfile importer (verified with
  `pnpm install --frozen-lockfile --lockfile-only`) and the renderer's Vite alias; its
  `src/index.ts` only re-exports the descriptor. Everything else in it is the phase's. If the
  phase needs another dependency, the lockfile importer is the integrator's to change.
- **ADR-013 / ADR-003: landed.** The descriptor's type and schema are in the provider SDK
  (`provider-sdk/telemetry.ts`: `TelemetryDescriptor`, `telemetryDescriptorSchema`,
  `TELEMETRY_FORMATS`, `MAX_TELEMETRY_SERIES`), because `ProviderManifest.telemetry?`
  carries it; a definition's `telemetry` is validated by the same schema and copied to its
  manifest. One difference from the brief: the descriptor is validated where the manifest
  is, so the package re-exports rather than defines it. A renderer import of
  `@worldview/telemetry` should stay type-only or pure — the provider SDK's index also
  exports `testing`, which imports `node:crypto`.

## Evidence

(filled in at the end)
