# Phase `telemetry` — Telemetry series and a Readings panel (Open MCT harvest)

Status: built, in review (the status line is set at hand-off) · Branch: `phase/telemetry` · Target: 0.2.0 · Owner: session 01JtWM

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

1. [x] `packages/telemetry/{package.json,tsconfig.json,src/…}` — on the integrator's stub
       (#8): `known.ts` (named keys, the weather-station default), `resolve.ts`
       (`resolveTelemetry`), `format.ts` (the fixed formats, limit state), `series.ts`
       (`projectReadings`, `downsample`, range, path, limit bands), `history.ts` (`readings`
       over `history.query`, `withLatest`).
2. [x] Descriptor tests (the schema is the SDK's; its defaults, discovery and formats are
       tested against it) and projection tests with history fixtures, through a real
       `HistoryStore` (`packages/telemetry/src/*.test.ts`,
       `fixtures/connectors/telemetry/local-sensors-history.json`).
3. [~] The Readings section (`apps/desktop/src/renderer/context/readings.tsx`,
   `readings-view.tsx`) registers itself for `weather-station` and `sensor` when imported —
   the import is **R1**; any other object whose provider carries a descriptor needs **R2**.
   Both are below.
4. [x] `docs/connectors/telemetry.md`, and two examples in `connectors/examples/telemetry/`.
5. [~] Changelog fragment written. Screenshots of the packaged app are the operator's (they
   need R1 landed and a Windows build).

## Definition of done

- [x] descriptor validation and projection tests green
- [x] the panel renders against fixture history in a renderer test (`readings.test.ts`:
      the view drawn from the fixture's projected series; the container inside the store in
      live and replay, before history answers — static rendering runs no effects, so the
      container's read itself is covered by `packages/telemetry`'s tests over a real store)
- [ ] shown on the packaged Windows build for a weather station and a PurpleAir sensor —
      not done: needs R1 and the operator's build
- [x] `phase-check` passes; the container's common checks green (ESLint and the Windows
      gate are the integrator's)

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

## Decisions

- **The package exports nothing from the provider SDK at run time.** The stub re-exported
  `telemetryDescriptorSchema`, `telemetrySeriesSchema`, `TELEMETRY_FORMATS` and
  `MAX_TELEMETRY_SERIES` as values, which pulls the SDK's index — and its `testing` export's `node:crypto` — into the renderer
  bundle. `index.ts` now re-exports the descriptor types only; validate with the SDK's
  schema (the manifest already is). A test fails if a package module imports the SDK at run
  time or any `node:` module.
- **Series are the keys the object carries.** A source descriptor's series are offered only
  where the current payload has the key as a number, first provider first; else the type's
  default (weather station: temperature, humidity, sea-level or station pressure, wind,
  gusts); else, for a sensor or a weather station none of whose defaults it has, every
  numeric key — named and given units from `KNOWN_READINGS` where the key is a known one,
  under its own name otherwise, never coordinates or `…Id` keys.
- **Formats label, never convert** (the SDK's own rule): `FORMAT_RULES` gives decimals and
  a default unit per format, keyed by the SDK's format type so a new format fails the
  typecheck until it has a rule. The AQI default carries its category edges (100, 150) as
  limits; no other default has limits.
- **The projection uses `history.query` as it is** (no new channel, as the brief says):
  the window is cut into 60 slices plus one ending at its start, and each slice asks for
  the objects known at its end with the slice as look-back, limited to the type and the
  object's providers — and, for a weather station only, to a 250 m circle (history filters
  by each observation's own position, so a moving sensor must not be narrowed by where it
  is now). That gives the last reading per slice: exact for sources slower than a slice,
  blind to a spike between two slice ends of a faster one. R3 would make it exact. Reads
  run four at a time, abort with the section, and a failed slice — or one cut short by the
  2,000-object limit without the target — is counted and said, never filled. Results come
  back in slice order, so which reading wins an instant does not depend on timing.
- **The window follows the timeline, and never shows the future of the cursor.** Its slice
  grid ends at the cursor (now when live) rounded up to a whole slice; the last slice is
  cut at the cursor, so nothing after it is read. Slices that are not cut short and end
  before both the object's own latest observation and a minute ago are cached — per
  object, keys, sources and station position, at most 1,000 — since nothing more can land
  in them (a source reports in order; an NWS observation arrives minutes late, and its
  slice is read again until the object shows it). So a window that
  moves on by a slice — live, or replay at 60× — reads one or two slices, not sixty-one.
  The previous read stays drawn (clipped to the new window) until the next arrives, and
  nothing is read while the cursor is being dragged. The object's own current values are
  added only while live: in replay the selected object can still be the live one. History
  is read once every source's manifest has answered, so the series do not change under a
  read already made; each manifest is asked for once, and a failed request counts as an
  answer. 1 h, 6 h, 24 h, 7 d. Click, Enter or
  Space on a chart seeks the replay cursor there (`actions.seekTo`), as the track profile
  does.
- **Gaps.** The line breaks where readings are more than three times their median spacing
  apart (never less than a slice): one or two missed readings are bridged, a real outage is
  not. With slices, a source slower than a slice leaves most slices empty, so an empty
  slice alone cannot mean a gap.
- **Styling reuses the track profile's classes** (`wv-track__*`); the only new colours
  are the limit bands, filled with the existing `--wv-warning-soft` and
  `--wv-danger-soft` tokens. `shell.css` is not the phase's.
- **The section reads history with `useClient()`**: `ShellActions` has no history action
  and `store/actions.ts` is not the phase's. Manifests are loaded with the existing
  `actions.loadManifest`.

## Amendment requests (new, from this phase)

- **R1 — import the section.** `apps/desktop/src/renderer/context/index.ts` (not owned by
  any phase) needs one line, `import './readings.js';`, beside `./sections.js`. Until then
  the section exists, is tested, and never appears in the app. It must come after
  `./sections.js` so `placement: { after: 'weather-station' | 'sensor' }` finds its anchor
  (the registry falls back to the end otherwise).
- **R2 — readings for any type whose source describes them.** A section's `render` gets
  `ContextSectionProps`, which carries neither manifests nor descriptors, so it cannot
  decide synchronously whether a tracker or an ingest reading has a descriptor, and a
  section that renders an empty body still shows its title. Smallest change: add
  `telemetry?: TelemetryDescriptor` to `SourceHealthEntry.meta` (filled where `meta` is
  built from the manifest), then register `readingsSection` under `'*'` with `render`
  passing `sources.find(…)?.meta.telemetry` into `resolveTelemetry`. (Alternative:
  `manifests` on `ContextSectionProps`, with the panel loading the selected object's
  manifests.)
- **R3 — every observation of one object.** `history.readings: { objectId, keys (≤ 32),
time } → Array<{ observedAt, values: Record<string, number> }>`, served from
  `HistoryStore.backend.track(objectId, range)` rows (already filtered by object and time),
  capped (e.g. 20,000 rows, `truncated` flag). `projectReadings` already takes such rows;
  only `readings()` changes, from up to 61 requests to one, and spikes inside a slice survive
  (then thinned with min/max buckets).
- **R4 — a batch keeps one observation per object** (`connector-sdk/records.ts`
  `mapRecords`: a second record with the same `externalId` is rejected as a duplicate, the
  first one listed wins). A source that returns a backlog — the last N observations of a
  station, an append-only log — puts only one of them in history, and for an oldest-first
  log the one kept is the oldest, so it never updates. Smallest change: treat
  `(externalId, observedAt)` as the duplicate key and let the state engine keep the newest
  per object (history already stores every observation). Pinned by
  `connectors/examples/telemetry/telemetry.test.ts` ("known gap … R4"); the examples poll
  the latest value instead.
- **R5 — a valid definition can yield a manifest the host refuses.**
  `definitionToManifest` appends ` Connector: <the connector's display name>.` to the
  description; the definition schema allows 500 characters and so does the manifest's, so
  a definition description within about 22–34 characters of 500 (the display names differ)
  passes `connector:test` and is refused by `ProviderHost.register`
  (`manifestSchema`). Found when this phase's first CSV example (499 characters) passed the
  suite and failed the manifest check in its own test. Smallest change: truncate the
  combined text to 500 in `definitionToManifest`, or have the suite validate the manifest.
  Pinned by the same test file ("known gap … R5").

## Evidence

(filled in at the end)
