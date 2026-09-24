# Phase `provider-migration` — Classify and migrate bespoke providers

Status: complete — see the status line at the end · Branch: `phase/provider-migration` · Target: 0.2.0 · Owner: phase agent (2026-09-23)

## Goal

Every bespoke provider is classified KEEP, MIGRATE or HYBRID with a reason, the MIGRATE
ones are re-expressed as definitions in `connectors/enabled/` proving the connector layer
carries real sources, and nothing the app does today changes — the bespoke providers stay
registered and on until the integrator decides, per provider, to retire one.

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; [CONNECTOR-ECONOMICS.md](../../architecture/CONNECTOR-ECONOMICS.md);
every `providers/*/src/manifest.ts` and `normalize.ts`; `config/licenses/providers.json`;
`docs/providers/BUILDING-A-PROVIDER.md`; the connector guides.

## Scope

In: `docs/providers/MIGRATION-MATRIX.md` — one row per provider: transport, what it does
that a connector cannot, classification, the definition that would replace it (or the
transform/connector it would need), the evidence that the definition produces the same
observations (ids, positions, payload keys) against the provider's own fixtures. Definitions
for the MIGRATE set in `connectors/enabled/` with sidecars pointing at the existing
`fixtures/<provider>/` files, `review: "bundled"` **requested** (the file says
`user-configured`; the integrator flips it with the registry record), `enabled: false`;
`connectors/examples/migrated/` for the HYBRID ones showing how far a definition gets.

Out: deleting or disabling any bespoke provider; changing `config/licenses/providers.json`
(frozen; the matrix lists the records to add).

## Starting classification (verify, do not trust)

Verified and superseded by [the matrix](../../providers/MIGRATION-MATRIX.md): one MIGRATE
(`usgs-earthquakes`), five HYBRID (`nhc-storms`, `nws-alerts`, `nasa-firms`, `aisstream-io`,
`worldview-seed-airports`), ten KEEP. `nhc`, `firms` and `ais` do not migrate yet, and the
NWS alerts alone do not either; the table below is the brief as written.

| Provider                                                                             | Transport      | Likely   | Why                                                                                             |
| ------------------------------------------------------------------------------------ | -------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `usgs`                                                                               | http GeoJSON   | MIGRATE  | the reference case; `usgs-earthquakes-geojson` already does it                                  |
| `nhc`                                                                                | http JSON      | MIGRATE? | check the storm/track shapes; may need `explode` (one storm → cone + track + position) → HYBRID |
| `weather` (NWS alerts, stations)                                                     | http GeoJSON   | HYBRID   | zones → geometry join is not a mapping; alerts alone may MIGRATE                                |
| `firms`                                                                              | http CSV, key  | MIGRATE  | `csv` connector with a `path` credential and `boundsQuery`; check the date/time columns         |
| `celestrak`                                                                          | http TLE       | KEEP     | propagation is code                                                                             |
| `adsb-remote`                                                                        | http JSON      | KEEP     | coverage planning by point/radius; a bounds-only definition is HYBRID for a fixed region        |
| `ais` (AISStream)                                                                    | websocket JSON | MIGRATE? | subscribe frame with the key and a bbox; check the message shapes → likely MIGRATE              |
| `cctv-public`                                                                        | http, packs    | KEEP     | camera media, per-pack parsers, gateway                                                         |
| `infrastructure`                                                                     | filesystem     | HYBRID   | phase `files` first                                                                             |
| `readsb-local`, `ais-local`, `purpleair-local`, `weatherlink-local`, `cameras-local` | local          | KEEP     | local-device kit, detection, streams                                                            |

## Deliverables

1. [x] The matrix with evidence per row — `docs/providers/MIGRATION-MATRIX.md`, sixteen
       providers (the fifteen packages; `cctv-public` registers three).
2. [x] Definitions + sidecars for the MIGRATE set —
       `connectors/enabled/pending-review/usgs-earthquakes-feed.json`;
       `connector:test --all --dir connectors/enabled` green; the comparison test is
       `connectors/examples/migrated/migration.test.ts` (id, position, time, payload-key and
       value parity with each bespoke normalizer on its own fixtures; known gaps asserted).
       HYBRID examples: `nhc-storms-feed`, `aisstream-feed`, `adsb-lol-fixed-point` (the brief's
       fixed-region note for `adsb-remote`).
3. [x] Registry records to add — in the matrix, with the steps to ship, rehearsed in a
       throwaway worktree (evidence below).
4. [x] Changelog fragment (`docs/roadmap/phases/changelog/provider-migration.md`); status
       and evidence below.

## Definition of done

- [x] every provider classified with evidence
- [x] MIGRATE definitions pass the suite and the parity test
- [x] `phase-check` passes; every common check that runs in a container is green — lint
      and the Windows gate were not run (see Evidence)

## Decisions

- **`connectors/enabled/pending-review/`, not `connectors/enabled/`.** The brief asks for
  the MIGRATE definitions in `connectors/enabled/` as `user-configured` until the integrator
  flips them, but `pnpm license-audit` fails a `user-configured` file there ("shipped but not
  reviewed", `tools/license-audit/src/audit.ts`), so "all checks green" and the brief's
  placement could not both hold. The audit (`findDefinitions`), `stage:resources`
  (`STAGED_DIRS`) and the runtime (`resourcesDir/connectors/enabled`) read only the top level
  of the directory; `connector:test --all --dir` also walks its immediate subdirectories. A
  subdirectory is therefore owned, tested, and not shipped. The flip becomes: move up, set
  `review`, add the record. `migration.test.ts` asserts nothing pending review is read as
  shipped, and finds the file in either place.
- **Definition ids differ from the bespoke ids** (`usgs-earthquakes-feed`, not
  `usgs-earthquakes`): the loader refuses an id a registered provider uses (shown in the
  rehearsal). Identity for earthquakes is keyed on the provider id, so the definition takes
  `usgs-earthquakes` in the change that retires the bespoke provider; the test shows every
  object id then equals the provider's.
- **No definition file for NWS alerts, FIRMS or the seed airports.** NWS and FIRMS ids
  contain `:`, which every mapping refuses, and FIRMS's key-in-path cannot reach a request
  (A1, A2); a file that validates would admit nothing. The airports need phase `files`'s
  connector. Each is probed in the test instead: the id refusal, the path-credential
  failure, the bad-key body read as an empty catalogue, the first-vertex/centroid
  difference, and the airports mapping over all 87 features.
- **The definitions read the providers' own fixtures** (`fixtures/usgs/`, `fixtures/nhc/`,
  `fixtures/aisstream/frames/`, `fixtures/adsb-lol/`); nothing new in
  `fixtures/connectors/migrated/`, so both sides are compared on the same bytes.
- **Headings are read with `number`, not `headingDegrees`**, which adds floating-point noise
  (A3). AIS speed, course and heading are left out of the example: the transforms would show
  the ITU not-available sentinels as values.
- **The registry record opens the USGS policy** (`bundled` plus the `usgs-earthquakes`
  record's permissions), so that retiring the provider does not take earthquakes out of
  exports and packs; `commercially-reviewed` is noted as the alternative.

## Amendment requests

The full table, with what each unblocks, is in the matrix
([Amendment requests](../../providers/MIGRATION-MATRIX.md#amendment-requests)). In short:

- **A1 (defect)** `rest-json.ts` / `core/src/http.ts` — a `credential.as: "path"` definition
  throws on every request: `buildRequest` passes the URL through `new URL()`, which encodes
  `{TOKEN}` as `%7BTOKEN%7D`, and `substitutePathCredential` looks for the literal
  placeholder. Keep it literal or accept the encoded form; test through the real client.
- **A2 (defect)** `mapping.ts` `ID_VALUE` — allow `:` in external ids (URNs, composite ids).
- **A3** `transforms.ts` — `split`, `padStart`, `slice`, `between`, `urlOnHost`; fix
  `headingDegrees`' floating-point noise.
- **A4** `mapping.ts` / `definition.ts` — a `values` lookup, `concat` (INTEGRATION.md's
  expected amendment; FIRMS is the real source that needs it), `transform` on conditions,
  `altitudeDatum`, flags from conditions, a `centroid` position, `effectiveFrom` /
  `effectiveUntil`, a root path. `explode` is **not** needed for NHC: the provider emits
  one observation per storm.
- **A5** `websocket-json.ts` / `csv.ts` — an error message → AUTH, a data-silence timeout,
  viewport bounds in the subscribe frame; CSV `requiredColumns`.
- **A6** `definition.ts` / `rest-json.ts` — settings substituted into URL, query and headers.
- **A7 (defect in the gate)** `tools/dev/run-tests.mjs`, `tools/dev/tsconfig.tsx-loader.json`,
  `tsconfig.json` — `connectors/` is in no test root and no type-check include, so
  `migration.test.ts`, which ownership places there, is run by neither `pnpm test` nor
  `pnpm typecheck` (the stock run below has 950 tests and not this file's 19).

## Evidence

(filled in at the end)
