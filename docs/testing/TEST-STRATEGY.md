# Test strategy

Everything runs on Node's built-in test runner through `tsx` — no test framework
dependency. Groups come from directory convention, not configuration
(`tools/dev/run-tests.mjs`):

| Group | Location | What it proves | Command |
| --- | --- | --- | --- |
| unit | `src/**/*.test.ts` | parsing, transformation, identity, confidence, freshness, event rules, reducers, pure geometry | `pnpm test:unit` |
| contract | `test/contract/**` | every provider against the 16-check checklist, fixture-driven, no network | `pnpm test:contract`, `pnpm provider:test --all` |
| integration | `test/integration/**` | provider → state → history → events → feed → source health; IPC router; renderer store | `pnpm test:integration` |
| offline | `test/offline/**` | worldpack build/install/search and the composed runtime with the network off | `pnpm test:offline` |
| failure | `test/failure/**` | injected upstream and storage failures | `pnpm test:failure` |
| e2e | `test/e2e/**` | packaged desktop; runs on the operator machine, not in this container | manual |

`pnpm test` runs everything except e2e and writes a summary to
`artifacts/verification/tests/<group>.json`, which the release verification report reads.

## The pyramid in practice

Most assertions are unit-level and pure. The contract layer is the widest *automated*
gate: a provider is not complete because files exist — it is complete when its checklist
report exists and passes (directive §96). Integration tests stitch the real packages
together with fixtures and a virtual clock, so they are fast and deterministic.

## Determinism

- Virtual clocks (`testing.VirtualClock`) everywhere time matters; no `setTimeout`-based
  waiting in assertions.
- Fixtures have a fixed reference time (2026-09-21T08:00:00Z) and are synthetic wherever
  a provider's terms forbid redistributing recorded payloads (directive §93).
- Randomised data uses a seeded generator so a benchmark or spatial test reproduces.

## Failure injection (directive §118)

Covered today: HTTP 429 with `Retry-After`, HTTP 500/503 with retry and circuit opening,
connect timeout, DNS failure, invalid JSON, oversized payload, truncated body,
websocket disconnect and reconnect, bad auth (401/403), stale-while-error, provider
throwing on every poll, provider with an invalid manifest, history backend throwing on
append, retention sweep unable to rewrite a partition, DuckDB module absent, camera
upstream 500/timeout/non-image, one camera pack failing while another succeeds,
corrupt and tampered worldpacks, corrupt settings file, failing migration.

The rule these tests encode: **one failing thing never takes the application down**, and
a failure is always visible in source health or diagnostics rather than silent.

## Network-off mode (directive §117)

`pnpm test:offline` sets `WORLDVIEW_NETWORK=off`. In that mode the composed runtime must:
start, serve the local map and pack search, keep collections and history working, report
every remote provider OFFLINE, keep filesystem/local-process providers answering, and
make zero HTTP requests. Offline support is claimed only because this passes.

## What cannot be proven in the build container

No npm registry access means Electron, Cesium, MapLibre, PMTiles, DuckDB and React are
not installed; type checking uses declaration shims for them, and the tests that need a
real WebGL canvas, a real DuckDB binding or a packaged app are `skip`ped with the reason
recorded in the TAP output. `artifacts/verification/typecheck.json` lists the active
shims and the release verification report repeats them under "not verified here". These
gaps close on the operator machine and in CI, where `pnpm install` runs.

Current counts: 463 tests, 0 failures, 7 skips (2 DuckDB, 4 Cesium/MapLibre/PMTiles,
1 satellite.js) across 101 files.
