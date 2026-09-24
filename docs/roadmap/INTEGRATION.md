# Integration

What the integrator does once phase branches come back, so that twelve branches built at
the same time become one `develop` that passes the gate, and then 0.2.0. One person (or one
agent) does this; the phases do not merge themselves.

## Base commit

Phases branch from `develop` at the commit recorded here. The integrator updates this
line whenever `develop` moves in a way phases must rebase onto (an amendment landed):

```
base: develop @ <sha of the connector-architecture merge>   (set when feature/connector-architecture is merged)
amendments landed since: (none)
```

## Amendments

A phase that needs a frozen contract changed writes an amendment request in its brief
(`## Amendment requests`). The integrator:

1. Reads the request; if it is the smallest change that does the job, makes it on
   `develop` directly (a `fix/` or `feature/` branch, gate green, merged): the code, its
   test, and one dated line under `## Amendments` in the ADR that owns the contract
   (ADR-002 world model, ADR-003 provider contract, ADR-013 connectors, ADR-004 desktop/IPC).
2. Records it under "amendments landed since" above and tells the phase to rebase
   (`git rebase origin/develop`).
3. If two phases ask for overlapping changes, makes one change that serves both and says
   so in both briefs.

Amendments the framework already expects (the briefs say which phase asks):

| Amendment                                                                                                                                                                       | Contract               | For phases                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------- |
| `ProviderSockets` or a new `ProviderMqtt` on `ProviderContext`: subscribe/unsubscribe to topics on a broker, host allow-list, TLS, credential as username/password by reference | ADR-003                | `mqtt` (and `home-assistant` if it uses MQTT discovery) |
| A local listener: `ProviderLocalAccess.listen(port, handler)` bound to loopback only, token-authenticated, size- and rate-capped, off by default                                | ADR-003                | `ingest`                                                |
| Source Health entries carry `connector?: string` and `definitionFile?: string`; `sources.definitions.list/reload/setEnabled` IPC; `sources.definitions.folder`                  | ADR-004 (IPC), ADR-013 | `source-health-ui`                                      |
| `Observation.payload` conventions for a `telemetry` descriptor, or `ProviderManifest.telemetry?`                                                                                | ADR-002 / ADR-003      | `telemetry`                                             |
| `ObjectTypes` gains `imagery-scene` (or STAC items map to `place` with a `kind`)                                                                                                | ADR-002                | `stac`                                                  |
| A raster overlay layer contract for WMS/WMTS (a layer the renderers draw, not observations)                                                                                     | ADR-008                | `ogc`                                                   |
| `mapping.explode` (one record → many) and `mapping.concat` if a real source needs them                                                                                          | ADR-013                | any connector phase                                     |

## Merge order

Lowest-risk and most-depended-on first, so later rebases are onto a stable base:

1. `provider-migration` (definitions only; establishes `connectors/enabled/` and the
   migration matrix)
2. `arcgis`, `ogc`, `stac`, `files` (connector directories; no amendments except `ogc`'s
   overlay and `stac`'s object type, which land before their branches)
3. `mqtt` (after its transport amendment), then `home-assistant`, `traccar`
4. `ingest` (after its listener amendment)
5. `telemetry`
6. `source-health-ui` (after its IPC amendment; it touches the renderer, so last among code)
7. `offline-basemaps` (tooling and docs; independent)

## Per branch

```
git fetch origin
git checkout phase/<id> && git rebase origin/develop      # the phase's own rebase; conflicts are in slot files only
pnpm install                                               # if the lockfile moved
pnpm phase-check                                           # must pass on the rebased branch
pnpm format:check && pnpm lint && pnpm typecheck && pnpm boundary-check && pnpm test
pnpm connector:test --all && pnpm provider:test --all && pnpm license-audit && pnpm todo-report
```

Then on `develop`: `git merge --no-ff phase/<id>` with a message that names the phase and
its brief; run the full gate again (`check.bat` on the Windows machine for the packaged
build). The merge commit carries the repository's author identity and no trailers.

### Slot-file conflicts

The only files two phases both edit are the slot files. A conflict there is always "both
sides added a line at their own marker": keep both, keep the markers, keep the blank lines
between them. If a phase edited a line that is not its own slot, its `phase-check` would
have failed — send it back rather than resolving by hand.

### Changelog and roadmap

Merge each `docs/roadmap/phases/changelog/<id>.md` into `CHANGELOG.md` under
`[Unreleased]`, in the order merged, keeping the phase's wording; delete the fragment in the
same commit. Tick the phase in `ROADMAP.md` 0.2.0 and record the merge sha in the brief's
status line. Move the brief's amendment requests that were declined to the roadmap's
"deferred" list with the reason.

## The refactor pass

After the last merge and before the version bump, one pass over the whole, with no new
behaviour:

1. **Duplication across connectors.** Capabilities parsing, GeoJSON-through-a-query
   patterns, credential handling, health messages: anything two connectors wrote twice
   moves into `connector-runtime/src/shared/` (a new, integrator-owned directory) with the
   callers changed and the suite unchanged.
2. **Transform registry.** Transforms phases added in their own connectors (they could not
   touch the SDK) are promoted into `connector-sdk/src/transforms.ts` with tests; the
   connector-local copies are deleted.
3. **Docs index.** `docs/connectors/README.md` slots become a table; `OVERVIEW.md`'s
   "which connector" table gains the shipped connectors; the harvest docs' "where it lands"
   columns point at real files.
4. **Ownership.** `ownership.json` is rewritten for the next round: shipped connectors move
   from a phase's `owns` to `frozen`; new phases are added.
5. **Gate.** The full gate on Windows, `connector:test --all --live` on a machine with
   network access for every bundled definition, and the QA checklist's connector rows.

## The release

`docs/releases/RELEASE-PROCESS.md` as usual: `apps/desktop/package.json` to `0.2.0-rc.1`,
the CHANGELOG heading, `pnpm release:assert-version`, tag, the human pushes and publishes.
