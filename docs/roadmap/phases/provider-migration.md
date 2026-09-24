# Phase `provider-migration` — Classify and migrate bespoke providers

Status: merged at `9524304` — see the status line at the end · Branch: `phase/provider-migration` · Target: 0.2.0 · Owner: phase agent (2026-09-23)

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
       providers (fourteen provider packages; `cctv-public` registers three ids).
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
  exports and packs; `commercially-reviewed` is noted as the alternative. Retention is the
  one policy field it cannot match (A8), so USGS is ready to ship beside the provider and
  not yet to replace it.
- **`observedAt` is required in the USGS definition**, so it refuses an unreadable time as
  the provider does; its remaining leniency on malformed rows is listed and tested.
- **An independent review** of the matrix against the code (a reviewer that had not seen
  the work) found thirteen inaccuracies — counts, a re-subscribe the AIS provider does not
  do, unlisted datum and malformed-row differences, the retention cap, a test that would
  fail once `pending-review/` is emptied. All were checked and corrected; the tests now
  assert the datum, malformed-row and retention gaps and compare the AIS static-data vessel.

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
  the viewport's bounds in the subscribe frame; CSV `requiredColumns`.
- **A6** `definition.ts` / `rest-json.ts` — settings substituted into URL, query and headers.
- **A7 (defect in the gate)** `tools/dev/run-tests.mjs`, `tsconfig.json` — `connectors/` is
  in no test root and no type-check include, so `migration.test.ts`, which ownership places
  there, is run by neither `pnpm test` nor `pnpm typecheck` (the stock run below has 950
  tests and none of this file's 21). Named directly, tsx runs it as is.
- **A8** `definition.ts` (`resolveDataPolicy`) — let a reviewed definition set no retention
  cap. Every definition is capped (seven days by default); the USGS provider sets none and
  earthquakes are kept indefinitely, so replacing it would prune their history.

## Evidence

All of it from the container, at `78075ab` — the branch rebased onto `develop @ b13df65`
after the `imagery-scene` amendment landed mid-phase; every check below was re-run after
the rebase. Commands as in `worldview-phase-agent.md`; Prettier is the pinned
`prettier-3.9.8.tgz` from the operator's `wv-build` folder, unpacked in a scratch directory.

`node tools/dev/phase-check.mjs provider-migration --base origin/develop`

```
[phase-check] phase=provider-migration branch=phase/provider-migration base=origin/develop (b13df655c1) files=14
   connectors/enabled/README.md
   connectors/enabled/pending-review/usgs-earthquakes-feed.json
   connectors/enabled/pending-review/usgs-earthquakes-feed.test.json
   connectors/examples/migrated/adsb-lol-fixed-point.json
   connectors/examples/migrated/adsb-lol-fixed-point.test.json
   connectors/examples/migrated/aisstream-feed.json
   connectors/examples/migrated/aisstream-feed.test.json
   connectors/examples/migrated/migration.test.ts
   connectors/examples/migrated/nhc-storms-feed.json
   connectors/examples/migrated/nhc-storms-feed.test.json
   docs/providers/MIGRATION-MATRIX.md
   docs/roadmap/phases/changelog/provider-migration.md
   docs/roadmap/phases/provider-migration.md
 ~ fixtures/connectors/README.md  [shared]
[phase-check] shared slot files touched: 1 (integrator reviews the slot lines)
[phase-check] PASS
```

`node tools/dev/run-tests.mjs` — the whole workspace; `migration.test.ts` is not among the
184 files (A7):

```
✔ verification report: the real repository has no failing evidence (353.890062ms)
ℹ tests 950
ℹ suites 0
ℹ pass 942
ℹ fail 0
ℹ cancelled 0
ℹ skipped 8
ℹ todo 0
ℹ duration_ms 76300.487709

[tests] group=all files=184 pass=942 fail=0 -> artifacts/verification/tests/all.json
```

`node --import tsx --test connectors/examples/migrated/migration.test.ts`

```
✔ every migrated definition and hybrid example passes the shared connector suite from its sidecar (1691.967477ms)
✔ until reviewed, every definition is user-configured, disabled, opens no data policy and is not shipped (0.776192ms)
✔ usgs-earthquakes: the definition matches the bespoke normalizer on fixtures/usgs/normal.geojson (2.808217ms)
✔ usgs-earthquakes: the definition matches the bespoke normalizer on fixtures/usgs/stale.geojson (1.794809ms)
✔ usgs-earthquakes known gaps: aliases, quality flags and the altitude datum are not carried (3.05003ms)
✔ usgs-earthquakes known gap: a non-numeric magnitude drops the field, not the event (1.064512ms)
✔ usgs-earthquakes: which malformed rows each side refuses (a definition is more lenient) (3.292692ms)
✔ usgs-earthquakes known gap: a reviewed definition still caps retention at seven days (0.534384ms)
✔ usgs-earthquakes: object identity is the same only under the bespoke provider id (2.524699ms)
✔ nhc-storms: ids, positions, times and shared values match; the storm-id check and four keys do not (1.586125ms)
✔ nws-alerts: every alert id is a URN with colons, which a mapping refuses as an external id (2.355102ms)
✔ nws-alerts: a polygon's representative point is its first vertex in a mapping, its centroid in the provider (0.43561ms)
✔ aisstream-io: positions, times and names match; short MMSIs are not padded and lose vessel identity (552.966638ms)
✔ aisstream-io: why motion is left out of the example — the mapping would show "not available" as a value (1.112495ms)
✔ aisstream-io: a rejected API key is AUTH in the provider and silence in the definition (552.649815ms)
✔ adsb-lol fixed point: ids, positions and motion match; ground, military, time and non-ICAO naming do not (3.179347ms)
✔ transform defect: headingDegrees adds floating-point noise to an in-range heading (0.171134ms)
✔ nasa-firms: a detection id joins four columns with colons; a mapping can neither build nor accept one (0.971255ms)
✔ nasa-firms: "Invalid MAP_KEY." is AUTH to the provider and an empty, healthy catalogue to the csv connector (1.019469ms)
✔ nasa-firms: a path credential never reaches the request — rest-json encodes {TOKEN} before the host substitutes it (1.391635ms)
✔ worldview-seed-airports: the mapping reproduces all 87 airports; the dataset date is not per record (2.319708ms)
ℹ tests 21
ℹ pass 21
ℹ fail 0
ℹ skipped 0
```

`connector:test --all` and `connector:test --all --dir connectors/enabled`

```
PASS connectors/examples/citibike-stations-rest.json — citibike-nyc-stations (rest-json)
    14 pass, 0 fail → PASS
PASS connectors/examples/migrated/adsb-lol-fixed-point.json — adsb-lol-fixed-point (rest-json)
    14 pass, 0 fail → PASS
PASS connectors/examples/migrated/aisstream-feed.json — aisstream-feed (websocket-json)
    10 pass, 0 fail → PASS
PASS connectors/examples/migrated/nhc-storms-feed.json — nhc-storms-feed (rest-json)
    14 pass, 0 fail → PASS
PASS connectors/examples/sample-websocket.json — sample-vehicle-feed (websocket-json)
    10 pass, 0 fail → PASS
PASS connectors/examples/usgs-earthquakes-csv.json — usgs-earthquakes-csv (csv)
    14 pass, 0 fail → PASS
PASS connectors/examples/usgs-earthquakes-geojson.json — usgs-earthquakes-connector (geojson)
    14 pass, 0 fail → PASS
PASS connectors/enabled/pending-review/usgs-earthquakes-feed.json — usgs-earthquakes-feed (geojson)
    14 pass, 0 fail → PASS
```

`license-audit`, `todo-report`, `stage-resources --check`, `boundary-check`

```
Providers  16/16 manifests and definitions matched against 73 registry records
Software   37 records (20 bundled, 2 conditional)
Assets     69 records (26 cleared: 4 imported / 22 not imported, 37 excluded, 6 review)
0 errors, 0 warnings → PASS
[todo-report] files=573 markers=0
[stage-resources] up to date: apps/desktop/resources/data/airports.geojson
[stage-resources] up to date: apps/desktop/resources/data/demo-earthquakes.geojson
[boundary-check] files=647 violations=0 → PASS
```

`typecheck` exited 0 with the shims it always uses in a container:

```
[typecheck] tsconfig.json (shims: @cesium/engine, @duckdb/node-api, cesium, electron, electron-updater, maplibre-gl, pmtiles, react, react-dom, react-dom/client, react-dom/server, react/jsx-runtime, satellite.js)
[typecheck] tsconfig.renderer.json (shims: @cesium/engine, @duckdb/node-api, cesium, electron, electron-updater, maplibre-gl, pmtiles, react, react-dom, react-dom/client, react-dom/server, react/jsx-runtime, satellite.js)
```

`migration.test.ts` is outside `tsconfig.json`'s include (A7), so it was type-checked on its
own: `tsc -p` with a scratch config extending `tsconfig.json` over `connectors/**/*.ts`,
plus `--noUnusedLocals --noUnusedParameters` as a stand-in for the lint rules on unused
code — exit 0, no output. `prettier --check .` — `All matched files use Prettier code
style!`

A1, reproduced with the real `RestJsonProvider.buildRequest` and `substitutePathCredential`
(a scratch script, before the test pinned it):

```
definition validates: true
request url the connector hands the HTTP client: https://firms.modaps.eosdis.nasa.gov/api/area/csv/%7BTOKEN%7D/VIIRS_SNPP_NRT/-160.00000,18.00000,-154.00000,23.00000/1
credential: {"key":"repro.mapKey","as":"path"}
substitutePathCredential threw: ProviderError: credential placeholder {TOKEN} is not present in the request path
```

The registry steps, rehearsed in a throwaway worktree of `78075ab` (definition and sidecar
moved up, `pending-review/` removed, `review: "bundled"` with the policy of step 2, the
record parsed out of the matrix and appended to `providers.json`, then staged; the last four
lines are the runtime's loader reading the staged directory):

```
Providers  17/17 manifests and definitions matched against 74 registry records
0 errors, 0 warnings → PASS
PASS connectors/enabled/usgs-earthquakes-feed.json — usgs-earthquakes-feed (geojson)
    14 pass, 0 fail → PASS
[stage-resources] staged connectors/enabled/usgs-earthquakes-feed.json → apps/desktop/resources/data/connectors/enabled/usgs-earthquakes-feed.json
stage --check exit=0
ℹ tests 21
ℹ pass 21
ℹ fail 0
reserved bespoke ids: 16 | includes usgs-earthquakes: true
loaded: usgs-earthquakes-feed review=bundled enabled=false | problems: 0
manifest: usgs-earthquakes-feed conditional | enabledByDefault false | export true | maxRetentionSeconds 604800
same id as a registered provider → [{"file":"usgs-earthquakes-feed.json","errors":["id \"usgs-earthquakes-feed\" is already used by another provider"]}]
```

Authorship: the handbook's two checks pass — the commit messages since `origin/develop`
carry no trailer and no assistant name (the case-insensitive count is 0), and a
case-insensitive `git grep` of the tree for that name finds nothing; every commit is
`the-x1x1 <connersalt123@outlook.com>`.

**Not run, and why:** `pnpm lint` (eslint is not installed in the container; the code was
written to the rules that bite — no unused code, `prefer-const`, no `any`); the Windows gate
(`check.bat`: install, lint, a typecheck without shims, package); `connector:test --live`
(the container's proxy answers 403 to every public host). Nothing here was checked against a
live source: every comparison is on the providers' own fixtures, which their READMEs
describe as synthetic apart from NHC's Odalys entry and the seed airports (the bundled
dataset itself). The independent review of the matrix (see Decisions) read the code; it did
not run the Windows gate either.

Status: complete at `78075ab` (on `develop @ b13df65`) — every container check green; lint,
the Windows gate and `--live` not run (above). The commit after `78075ab` adds only this
section and status line.

Merged into `develop` at `9524304` (2026-09-23); A1, A2, A7 and A8 landed in the following
commit, with `migration.test.ts` asserting the fixed behaviour. A3–A6 are deferred to the
refactor pass (ROADMAP.md).
