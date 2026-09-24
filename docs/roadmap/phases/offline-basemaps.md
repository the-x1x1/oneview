# Phase `offline-basemaps` — Planetiler/Protomaps extracts and a Martin tile source

Status: complete at `5d1a2af` (on `59d546d`). Every container check is green. Not done
here:

- a real Planetiler build, which needs the operator's machine;
- the offline check in the app, which amendment B2 blocks for every basemap pack;
- the Martin source in the app (B4, B5);
- the registry record (B1).

Branch: `phase/offline-basemaps` · Target: 0.2.0 · Owner: session 01EGPj (2026-09-24)

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

1. [x] `tools/basemap/src/`:
   - `cli.ts`: the CLI, replacing the placeholder;
   - `planetiler.ts`: detecting Java and the jar, the input check, the command line, the
     runner;
   - `build.ts`: orchestration, the registry policy, the pack and the report;
   - `pmtiles.ts`: reads the PMTiles v3 header and metadata;
   - `osm-pbf.ts`: reads the extract's header bounding box;
   - `basemap.test.ts`: 24 tests.
2. [x] `packages/offline/src/basemaps/martin.ts` and `martin.test.ts` (8 tests: the URL
       policy, TileJSON parsing, attribution, `/catalog`, and real HTTP on loopback). It
       cannot be imported from outside the package until B5.
3. [x] `docs/OFFLINE-BASEMAPS.md` covers the Planetiler workflow end to end, every input
       with its licence and source, the registry record to add, the Martin setup and what the
       app cannot do yet. Not done: **sizes and times for a preset region.** No real build has
       been made, so the section says none have been measured, and names the report fields
       that will give them.
4. [ ] A pack built for one preset region and verified offline on the packaged Windows
       build. **Not done.** It needs Java 21, the Protomaps jar, a Hawaii extract and the six
       inputs on the operator's machine. Even then the app cannot draw it until B2 lands. The
       commands are under "For the operator" below.
5. [x] Changelog fragment `docs/roadmap/phases/changelog/offline-basemaps.md`; this status
       and evidence.

## Definition of done

- [ ] **An extract built by the tool loads offline in the app.** Blocked by **B2**:
      nothing puts an installed pack's PMTiles path into the basemap descriptor. It is also
      unrun: no real extract has been built.
- [ ] **The Martin source shows tiles from a local Martin.** Blocked by **B4** and **B5**.
      The read side is tested against a loopback HTTP server that serves a TileJSON invented
      in Martin's published shape. It has not been run against a real Martin.
- [ ] **The licence audit passes with the new attribution entries the integrator adds.**
      Waits for **B1**. The audit passes today, but the record is not in the registry yet.
- [x] **`phase-check` passes, and all common checks run in the container are green.**
      ESLint, Prettier 3.9.8 and the Windows gate are for the integrator.

## Decisions

- **The Protomaps basemap profile, not a stock Planetiler jar.** The app's 2D styles read
  the Protomaps schema (`earth`, `water`, `roads`, `places`, `boundaries`, …). Stock
  Planetiler writes OpenMapTiles layers, which would draw nothing. The Protomaps profile
  (github.com/protomaps/basemaps, `tiles/`) is a Planetiler application whose jar bundles
  Planetiler. A jar is recognised by `com/protomaps/basemap/Basemap.class` in its central
  directory, zip64 included. It is **never run** to ask what it is: run with an unknown
  argument, the profile would start a build, and fetch its inputs, in whatever directory it
  was run from. Its SHA-256 identifies it in the report.
- **Where the jar is looked for.** The brief says "the jar path from settings/PATH", but a
  CLI cannot read the app's settings. So the order is `--jar`, then
  `ONEVIEW_PLANETILER_JAR`, then `protomaps-basemap-*-with-deps.jar` in any `PATH`
  directory. Java is looked for through `--java`, then `JAVA_HOME`, then `PATH` (with
  `PATHEXT` on Windows), and must be version 21 or newer.
- **Nothing is downloaded, by construction.** The profile would download its sources when
  given `--download` or `--refresh_<source>`. It always downloads `qrank.csv.gz` and
  `pgf-encoding.zip` when they are missing from `data/sources/` under its working
  directory. So:
  - all six inputs must be in `<work>/data/sources/` before Java starts;
  - `download`, `only_download`, `refresh_sources`, `refresh_{osm,ne,osm_water,osm_land,landcover}`
    and `fetch_wikidata` are set to `false` on the command line (explicit arguments win
    over Planetiler's JVM-property and environment sources);
  - Java runs without `PLANETILER_*` variables, and without `JAVA_TOOL_OPTIONS`,
    `JDK_JAVA_OPTIONS` and `_JAVA_OPTIONS`, which can set `planetiler.*` properties
    directly or through an argument file.

  The docs list each input with its licence and URL for the operator to fetch.

- **"The existing pack-download consent flow" does not exist.** `download-offline-pack` →
  `actions.installOfflinePack` → the runtime's `offline.installPack` → a file picker for a
  local `.worldpack`. Nothing in `packages/`, `apps/` or `tools/` downloads a pack or an
  extract; an independent review confirmed this. So the tool takes a local `.osm.pbf` and
  records the page it came from (`--osm-url`, https, never fetched). If the operator wants
  the app or the tool to fetch Geofabrik extracts, that consent flow has to be designed
  first. That is the operator's decision and is not requested here.
- **A registry record of its own: `osm-protomaps-planetiler`.** The existing
  `protomaps-builds` record would give the wrong provenance: it names Protomaps' daily
  builds, and these are the operator's own builds from their own extract. Its data terms
  are the same (ODbL, share-alike on redistributed modified extracts). The attribution is
  "© OpenStreetMap contributors, ODbL · Protomaps basemap (BSD-3-Clause) · Landcover: ESA
  WorldCover (CC BY 4.0)". The Daylight landcover layer comes from ESA WorldCover under
  CC BY 4.0, which requires credit (protomaps/basemaps `LICENSE_DATA.md`, read
  2026-09-24; worth confirming when B1 lands). Packing is
  refused until the record exists (fail closed). `--pmtiles-only` works meanwhile.
- **The region check reads the extract, not the output.** Planetiler writes `--bounds` into
  the archive header, so checking the output could never fail. The extract's OSMHeader
  `HeaderBBox` is read before Java starts:
  - no overlap with the region → refused;
  - partial cover → a warning;
  - no box, or one across the antimeridian → a warning that it was not checked.
- **Each run has its own directory**, `<work>/run-<id>-<time>-<random>`. It is created fresh under
  that random name, holds Planetiler's output and scratch files, and is removed when the
  run ends. After Ctrl-C the child is waited for (SIGTERM, then SIGKILL after 10 s)
  before anything is removed. Nothing else under `<work>` is touched.
- **What the Martin source accepts:**
  - Hosts follow ADR-003's local-endpoint rule, plus https for public hosts. Loopback, or
    the one trusted host, may use http or https.
  - Any other host must be https under a public name. Private, reserved, multicast,
    documentation and CGNAT IPv4, IPv6 literals, private-use suffixes and single labels
    are refused.
  - Tile templates must share the TileJSON's scheme and origin. No redirects; 1 MiB and
    10 s caps.
  - The Protomaps layers are required, because the styles draw only those.
  - Attribution comes from the TileJSON or from the operator, reduced to text with no
    markup. A source credited by neither is refused.
  - `publicHostProblem` follows connector-sdk `checkUrl`'s rules and also refuses the
    multicast, reserved, benchmarking and documentation ranges, which `checkUrl` does not.
    It is written out here because `@worldview/offline` does not depend on
    `@worldview/connector-sdk`, and adding that dependency would need an amendment.

## Amendment requests

- Root scripts `basemap:build`, lockfile importer for `tools/basemap`, tsconfig path.
  **Landed** (2026-09-24, integrator item #11): `pnpm basemap:build` runs
  `tools/basemap/src/cli.ts`; `tools/basemap/package.json` (`@worldview/tool-basemap`,
  depending on `@worldview/offline` and `@worldview/world-model`) has its lockfile importer;
  `tools/*/src` is already in the root tsconfig, and `tools/basemap/tsconfig.json` is there
  for a package-local check. The `cli.ts` in place is a placeholder that says it is not
  built and exits 2 — the phase replaces it. A new dependency (even a workspace one) needs
  the importer changed again: ask. _(Used as landed; no dependency was added.)_
- Renderer: `map-providers.ts` gains a `martin` provider kind (frozen path) if the phase
  cannot express it through the existing pmtiles/tilejson path. _(It cannot; see B4.)_
- **B1: registry record.** Add `osm-protomaps-planetiler` to
  `config/licenses/providers.json`, as given in full in `docs/OFFLINE-BASEMAPS.md` §2. The
  operator should confirm `commercialReview: "approved"`, the same terms as
  `protomaps-builds`. Until then `basemap:build` refuses every pack.
- **B2: an installed pack's basemap reaches the map.** _(Blocks DoD 1 and deliverable 4. It
  affects every basemap pack, including one cut from a Protomaps build; found in this
  phase.)_
  - **The problem:** `MAP_PROVIDER_CATALOG`'s `worldview-dark` and `worldview-light` entries
    carry `url: ''` ("the runtime fills in the pack path"), and nothing does.
    - `core.packs.pmtilesPaths()` is used only for `offlineBasemapAvailable`
      (packages/runtime/src/handlers.ts:115).
    - `map-host.tsx:517` hands the descriptor through unchanged.
    - `styleForBasemap` therefore gets `pmtiles://` with no path.
  - **Smallest change:**
    - **Main process** (apps/desktop/src/main): serve the enabled pack's PMTiles file to the
      page, with HTTP range support, at an app-protocol route such as
      `worldview://app/__packs/<id>/maps/<file>.pmtiles`. It is on the page's own origin, as
      the tile cache's `/__tiles/` route is, so no CSP change is expected.
    - **Runtime** (`map.providers.list`): set the descriptor's `url` to that route for the
      first enabled pack with a `pmtiles` entry.
- **B3: the map's credit line for a pack basemap.** Today it is the catalog's fixed "©
  OpenMapTiles © OpenStreetMap contributors", whatever pack supplies the tiles. That names
  OpenMapTiles for Protomaps-schema tiles and leaves out Protomaps and ESA WorldCover. The
  runtime should take the `attribution` of the pack's `sourcePolicies` entry for the
  PMTiles content (render-core catalog and runtime).
- **B4: Martin in the app.**
  - **render-core:** a `BasemapDescriptor` variant
    `{ kind: 'vector-tiles'; id; tiles: string[]; minZoom; maxZoom; bounds?; styleId: 'worldview-dark' | 'worldview-light'; attribution }`.
  - **render-maplibre:** `styleForBasemap` builds a `vector` source from `tiles`, zooms and
    bounds instead of `pmtiles://`.
  - **Settings:** `basemap.martin.url`, `basemap.martin.trustedHost` and
    `basemap.martin.attribution` in `packages/config/src/settings-schema.ts` and
    `packages/ipc-contract`, with a control in the Settings dialog
    (apps/desktop/src/renderer).
  - **Runtime:** `map.providers.list` adds entries built from `readMartinBasemap`, marked
    unavailable with its `reason` when it fails.
  - **CSP:** `connect-src` (apps/desktop/src/main/csp.ts) already allows `https:`,
    `http://127.0.0.1:*` and `http://localhost:*`. It needs the configured origin added only
    for an http trusted host on the LAN (or `[::1]`, or a 127.x address other than
    127.0.0.1), and then exactly that origin.
- **B5: export the Martin source.** Add `export * from './basemaps/martin.js';` to
  `packages/offline/src/index.ts`. The package exports only `"."`, so nothing can import
  `readMartinBasemap`/`listMartinSources` until this lands.

## For the operator

Nothing here downloads anything. Java 21+, the Protomaps jar (`mvn clean package` in
`tiles/` of github.com/protomaps/basemaps), a Hawaii extract from Geofabrik and the six
inputs in `<work>\data\sources\` (docs/OFFLINE-BASEMAPS.md §1) are yours to fetch.

1. Run a dry run. The only thing it runs is `java -version`. Save its output:

   ```powershell
   pnpm basemap:build --region hawaii --out $HOME\Downloads\wv-build\basemaps `
     --osm $HOME\Downloads\hawaii-latest.osm.pbf `
     --osm-url https://download.geofabrik.de/north-america/us/hawaii-latest.osm.pbf `
     --jar <path>\protomaps-basemap-HEAD-with-deps.jar --memory 4g --pmtiles-only --dry-run *>&1 |
     Tee-Object -FilePath $HOME\Downloads\wv-build\basemap-dryrun.log
   ```

2. Build: the same line without `--dry-run`, teed to `basemap-build.log`. Leave
   `--pmtiles-only` on until B1 lands, and drop it afterwards to get the pack.
3. Keep `basemaps\basemap-hawaii.basemap-report.json`. Its sizes and times go into the
   "Sizes and times" section of the docs.

## Evidence

Container, `phase/offline-basemaps` at `5d1a2af` on `origin/develop` = `59d546d`, Node
22.22.2, Linux. Java 21 (`openjdk version "21.0.10"`) is installed here. No Protomaps jar
is, and none was downloaded.

```
node tools/dev/typecheck.mjs                     → exit 0 (tsconfig.json + tsconfig.renderer.json, with the usual shims)
node tools/dev/boundary-check.mjs                → [boundary-check] files=707 violations=0 → PASS
node tools/dev/run-tests.mjs                     → tests 1181 · pass 1173 · fail 0 · skipped 8 (natives)
node --import tsx tools/connector-validator/src/cli.ts --all → 23 definitions → PASS, exit 0
node --import tsx tools/license-audit/src/cli.ts → 0 errors, 0 warnings → PASS
node --import tsx tools/dev/todo-report.mjs      → [todo-report] files=626 markers=0
node tools/dev/stage-resources.mjs --check       → up to date, exit 0
prettier 3.8.1 (container copy) --check on every changed file → All matched files use Prettier code style!
tsc --noUnusedLocals --noUnusedParameters        → no finding in tools/basemap or packages/offline/src/basemaps
phase tests (basemap.test.ts + martin.test.ts)   → tests 32 · pass 32 · fail 0

[phase-check] phase=offline-basemaps branch=phase/offline-basemaps base=origin/develop (59d546db0b) files=11
   docs/OFFLINE-BASEMAPS.md
   docs/roadmap/phases/changelog/offline-basemaps.md
   docs/roadmap/phases/offline-basemaps.md
   packages/offline/src/basemaps/martin.test.ts
   packages/offline/src/basemaps/martin.ts
   tools/basemap/src/basemap.test.ts
   tools/basemap/src/build.ts
   tools/basemap/src/cli.ts
   tools/basemap/src/osm-pbf.ts
   tools/basemap/src/planetiler.ts
   tools/basemap/src/pmtiles.ts
[phase-check] PASS
```

The real CLI in the container, with this container's Java and no jar, inputs, extract or
registry record. Java is found (it is not among the problems), and everything missing is
reported at once:

```
$ node --import tsx tools/basemap/src/cli.ts --region hawaii --out <scratch>/bm --osm <scratch>/none.osm.pbf --dry-run
basemap:build stopped at prerequisites:
  - Planetiler: no Protomaps basemap jar found (looked at --jar, ONEVIEW_PLANETILER_JAR and PATH for protomaps-basemap-*-with-deps.jar). Build it yourself from github.com/protomaps/basemaps (tiles/, "mvn clean package"); this tool does not download it
  - profile inputs missing from <scratch>/bm/work/data/sources (get each yourself; this tool downloads nothing): natural_earth_vector.gpkg.zip — … (all six, each with licence and URL)
  - OSM extract: <scratch>/none.osm.pbf is not a readable file
  - Licence: the legal registry (providers.json) has no record "osm-protomaps-planetiler", so the pack's attribution and licence are not recorded and packing is refused. Add the record (docs/OFFLINE-BASEMAPS.md) or use --pmtiles-only
exit 2
```

**What the tests show, and what they do not.**

- Java and Planetiler are test doubles: an `exec` that answers `-version` with this
  container's real output, and a `spawn` that writes a PMTiles file where `--output`
  points.
- The PMTiles files, jars (zip and zip64), OSM PBF headers and Martin TileJSON are all
  invented in the published formats. The tests say so.
- The end-to-end test builds a real `.worldpack` with the real `WorldPackBuilder`,
  verifies it with `verifyWorldPack`, and reads the credit from its extracted
  `licenses/NOTICES.md`.
- `spawnStreaming` is tested with real child processes: one slow to stop, one that ignores
  SIGTERM, and one that cannot start.
- The Martin reader is tested over real HTTP against a loopback server: redirects, size
  cap, timeouts, a body that stalls, and a reset.
- **Mutation checks.** Across the three commits, nineteen deliberate breaks of the
  current behaviour were each caught by at least one failing test, and the sources were
  restored byte for byte. A twentieth broke a check that has since been replaced (Java's
  option variables are now dropped rather than refused). The nineteen:
  - download switch on;
  - refresh switches dropped;
  - environment not scrubbed;
  - jar not inspected;
  - schema not checked;
  - registry not required;
  - the extract's bounding box not checked;
  - the old `<work>/tmp` removal;
  - scratch not removed;
  - settling before the child exits;
  - an antimeridian box refused;
  - PATH quotes kept;
  - Martin origin not checked;
  - Martin scheme not checked;
  - redirects followed;
  - http allowed to a LAN host;
  - body errors thrown;
  - markup kept;
  - reserved ranges allowed.

**Review.** An independent reviewer checked the work against this brief three times.

- **First pass: 16 findings.** The major ones:
  - the jar was run for `--version`;
  - JVM properties could re-enable downloads;
  - a region check that could never fail;
  - docs claiming an installed pack draws offline;
  - amendment requests not written down.
- **Second pass:** confirmed the 16 fixes and raised 8 more. The major one was a
  recursive delete of `<work>/tmp`, which the tool does not own.
- **Third pass:** confirmed those 8 fixes and the numbers in this brief, and raised small
  points about the brief's wording and one code comment.

Everything is fixed, in `e2ff45f`, `7104d9e`, `5d1a2af` and this brief. The code fixes
have tests; the wording fixes and the printed command's quoting do not.

**Not run here:**

- ESLint: typescript-eslint is not installed. The code was checked by hand against
  `eslint.config.js`.
- Prettier 3.9.8: 3.8.1 was used.
- The Windows gate.
- A real Planetiler build or a real Martin.
- The packaged app.
