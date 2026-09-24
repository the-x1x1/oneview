# Parallel phases

How several people — or several agents — build different parts of the roadmap at the same
time on one repository, and how their work comes back together without a week of conflict
resolution. The connector architecture ([ADR-013](../adr/ADR-013-connector-architecture.md))
was designed for this: every remaining connector is a file in its own directory, a slot in
two shared files, an example, fixtures and a guide. The same shape works for the phases that
are not connectors.

## The model

```
develop ──●────────────────────────────────────────────────●── 0.2.0
           \                                              /  integrator: rebase in order,
            ├── phase/ogc ─────────────●                 /   refactor pass, gate, tag
            ├── phase/arcgis ──────●                    /
            ├── phase/stac ──────────────●             /
            ├── phase/mqtt ───────────●               /
            └── phase/… ──────────────────────●──────┘
```

- **One phase, one branch, one owner.** A phase is a brief in `docs/roadmap/phases/<id>.md`
  and an entry in [`ownership.json`](phases/ownership.json). It is built on `phase/<id>`,
  branched from the integration branch (`develop`) at the commit named in
  [INTEGRATION.md](INTEGRATION.md). Nobody else commits to that branch.
- **Frozen contracts.** The world model, the provider SDK and runtime, the connector SDK,
  the IPC contract, the state engine, the runtime core, the app's main process, the release
  tooling and the four Wave 1 connectors are frozen for the duration. A phase that needs a
  change there does not make it: it writes an **amendment request** in its brief (what,
  why, the smallest change that would do) and continues against a local shim or a fixture;
  the integrator makes the change on `develop`, and the phase rebases. This is what keeps
  twelve branches mergeable.
- **Owned paths.** Each phase owns a set of globs — its connector directory, its examples,
  fixtures, guide, brief and changelog fragment — and changes nothing else.
  `pnpm phase-check` (`tools/dev/phase-check.mjs`) reads the branch's changes against
  `ownership.json` and fails on a frozen or foreign path; a phase runs it before every
  commit and its last commit passes it.
- **Shared slot files.** The registry list, the runtime's `index.ts`, the connector docs
  index and the fixtures README carry one marked slot per phase (`// phase:<id>`,
  `<!-- phase:<id> -->`), separated by blank lines. A phase edits only its own slot line, so
  branches that edit the same file merge cleanly. `phase-check` lists these as `~` for the
  integrator's attention.
- **No shared files that accumulate.** `CHANGELOG.md`, `ROADMAP.md`, `EXECUTION-STATUS.md`,
  `pnpm-lock.yaml`, `package.json` and the ADRs are the integrator's. A phase writes its
  changelog entry to `docs/roadmap/phases/changelog/<id>.md` (the integrator merges them),
  and adds no dependency without an amendment request (a dependency is a licence-audit and
  lockfile change).
- **Definitions of done are mechanical.** Every phase ends with the same checks (below) and
  its brief's own list; the integrator does not re-derive them.

## What every phase must do

1. Read: its brief, [ADR-013](../adr/ADR-013-connector-architecture.md),
   [docs/connectors/OVERVIEW.md](../connectors/OVERVIEW.md), [MAPPING.md](../connectors/MAPPING.md),
   [TESTING.md](../connectors/TESTING.md), [CONNECTOR-ARCHITECTURE.md](../architecture/CONNECTOR-ARCHITECTURE.md),
   and — for a connector phase — the Wave 1 connector nearest to it
   (`packages/connector-runtime/src/connectors/`). Read `CONTRIBUTING.md` and the constraints in
   [docs/PRODUCT-BOUNDARIES.md](../PRODUCT-BOUNDARIES.md).
2. Build only in the owned paths, filling the phase's slot lines in the shared files.
3. Prove it with data: fixtures in `fixtures/connectors/<id>/` (recorded where the source's
   terms allow a sample, otherwise invented in the published shape and said so in the
   fixtures README slot), example definitions with `*.test.json` sidecars, and a `*.test.ts`
   that runs `runConnectorSuite` on every example plus the phase's own edge cases.
4. Keep the properties the architecture promises: nothing executed from a definition, no
   network outside `ProviderContext`, https/wss only or the local-endpoint policy, fail-closed
   data policy, sizes capped, secrets by reference, attribution on every observation, no
   invented data (directive §138), no fake completion (§139).
5. Write the guide (`docs/connectors/<id>.md`) and the changelog fragment
   (`docs/roadmap/phases/changelog/<id>.md`, Keep-a-Changelog bullets under `### Added` /
   `### Changed` / `### Fixed`).
6. Keep the brief current: tick deliverables, record decisions and amendment requests in it.
7. Before every commit: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
   `pnpm boundary-check`, `pnpm test`, `pnpm connector:test --all`, `pnpm phase-check`.
   All green, or the commit waits.
8. Commit as the repository's author identity, with plain messages and no trailers of any
   kind (see `CONTRIBUTING.md`); the message says what changed and why, in the CHANGELOG's
   voice. Never force-push; never push to `develop` or `main`; never tag.
9. Finish by writing "Status: complete at `<sha>`" in the brief, with the phase-check and
   test output pasted under "Evidence", and stop. The integrator takes it from there.

## What a phase must not do

- Change a frozen path, even "just a type", even to fix a bug it found. Write the amendment
  request; if the bug blocks the phase, say so in the brief's status line.
- Touch another phase's owned paths, or a slot line that is not its own.
- Add a dependency, a script in the root `package.json`, a workspace package outside its
  owned paths, or a CI step.
- Open a data policy, mark a definition `bundled` or `commercially-reviewed`, or enable one
  by default. Review is the integrator's and the licence registry's (directive §6–8).
- Invent fixtures that claim to be recordings, or claim a source works live without having
  run `connector:test --live` on a machine with network access and pasted the result.
- Ask which connector to build next: the brief says what; the order within it is the
  phase's own.

## The phases

| Phase                | Title                                                                   | Depends on                             | Brief                                                        |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `ogc`                | OGC connectors: WFS, OGC API Features, WMS, WMTS                        | —                                      | [phases/ogc.md](phases/ogc.md)                               |
| `arcgis`             | ArcGIS REST: FeatureServer and MapServer                                | —                                      | [phases/arcgis.md](phases/arcgis.md)                         |
| `stac`               | STAC catalogues and item search                                         | —                                      | [phases/stac.md](phases/stac.md)                             |
| `files`              | Local files: GeoJSON, CSV, GPX, KML; GDAL import                        | —                                      | [phases/files.md](phases/files.md)                           |
| `mqtt`               | MQTT connector and the rtl_433 preset                                   | amendment: MQTT transport (integrator) | [phases/mqtt.md](phases/mqtt.md)                             |
| `home-assistant`     | Home Assistant                                                          | —                                      | [phases/home-assistant.md](phases/home-assistant.md)         |
| `traccar`            | Traccar                                                                 | —                                      | [phases/traccar.md](phases/traccar.md)                       |
| `ingest`             | HTTP ingest (Node-RED and anything that can POST)                       | amendment: local listener (integrator) | [phases/ingest.md](phases/ingest.md)                         |
| `telemetry`          | Telemetry series and a Readings panel (Open MCT harvest)                | —                                      | [phases/telemetry.md](phases/telemetry.md)                   |
| `source-health-ui`   | Sources and Source Health show connectors; the operator's folder in-app | amendment: IPC fields (integrator)     | [phases/source-health-ui.md](phases/source-health-ui.md)     |
| `provider-migration` | Classify and migrate bespoke providers                                  | —                                      | [phases/provider-migration.md](phases/provider-migration.md) |
| `offline-basemaps`   | Planetiler/Protomaps extracts and a Martin tile source                  | —                                      | [phases/offline-basemaps.md](phases/offline-basemaps.md)     |

Phases with an amendment dependency start anyway: the brief says how to build against a
fixture or a shim until the integrator lands the amendment, and the phase's suite must pass
without it.

## Starting a phase

```
git fetch origin
git checkout -b phase/<id> origin/develop        # at the commit INTEGRATION.md names
pnpm install
pnpm phase-check --list                          # what you own
pnpm connector:test --all                        # the baseline is green
```

Then the brief. When an agent is given a phase, the whole instruction is: "Build phase
`<id>` as docs/roadmap/PARALLEL-PHASES.md and docs/roadmap/phases/<id>.md say. Do not stop
at interfaces or documentation. Finish with the brief's status line and evidence."

## Ending a phase

The last commit on the branch has the brief's status line, the changelog fragment, every
check green and `pnpm phase-check` passing. The branch is pushed to `origin/phase/<id>` (by
the person with push rights) and a pull request is opened against `develop` with the brief's
evidence as its description. Nothing is merged by the phase: [INTEGRATION.md](INTEGRATION.md)
is what happens next.
