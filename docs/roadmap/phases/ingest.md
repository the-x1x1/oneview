# Phase `ingest` — HTTP ingest (Node-RED and anything that can POST)

Status: complete at `98b76c6` (brief and evidence in the commit after it) · Branch: `phase/ingest` · Target: 0.2.0 ·
Owner: session 01DJjFn6 (2026-09-24)

On `develop @ 59d546d`. Built on the landed listener (#7), no shim. Every container check is green (evidence below)
except `connector:test` run on the two ingest examples themselves: the shared suite cannot drive a pushed source yet
(**A1**), so they wait in `connectors/examples/ingest/awaiting-amendments/` and `ingest.test.ts` runs their fixtures
through the listener. Scope item not met by this phase: the token "generated and shown once in the settings" needs
the app (**A2**); until then the operator pastes one. Source Health lags for host-side refusals and a newly stored
token (**A3**). A real curl run against the real host and listener is pasted below. Not run: ESLint, Prettier 3.9.8
(3.8.1 was), the Windows gate, Node-RED, the app.

## Goal

Anything the operator can make emit HTTP — a Node-RED flow, a script, a Raspberry Pi, a
PLC gateway — can push observations in a documented envelope to a listener WORLDVIEW opens
on loopback, off by default, with a token. This is the escape hatch for every source that
has no API: the operator writes the glue in whatever they already use, and WORLDVIEW stays
declarative.

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; ADR-003 (nothing listens today —
this phase asks for the one exception, tightly bounded); ADR-010 (the security posture);
`packages/connector-runtime/src/connectors/websocket-json.ts` (batching, health).

## Scope

In: `http-ingest` — a definition names a path (`/ingest/<id>`), the listener binds
`127.0.0.1` only on a port from the provider settings (default 47311), a bearer token by
credential reference generated and shown once in the settings, `POST` of the envelope
`{ "schema": "oneview.ingest.v1", "source": "<id>", "records": [ … ] }` (records mapped by
the definition's mapping like any connector; also accepts a bare array), size and rate caps,
`202 Accepted` with counts, `401`/`413`/`429`/`400` with reasons, health showing the last
receipt and the pusher's user agent; a Node-RED example flow (JSON) and a curl example in the
docs.

Out: anything but loopback (a LAN bind is a later, reviewed amendment); TLS; long-polling;
WebSocket ingest; ingest of images or files.

## Deliverables

1. [x] ~~Amendment request written first; the connector built against a shim~~ — the listener landed (#7) before the
       phase started, so it is built on `ProviderLocalAccess.listen` and `testing.FixtureLocalAccess` directly. The
       requests this phase found are A1–A3 below.
2. [x] `packages/connector-runtime/src/connectors/ingest/{http-ingest,envelope}.ts`, `index.ts`; slot lines in
       `registry.ts`, `index.ts`, `docs/connectors/README.md`, `fixtures/connectors/README.md`.
3. [x] Two examples with sidecars (`node-red-weather-stations`: the envelope from Node-RED; `pi-soil-sensors`: a bare
       array from a script, records without a time) in `connectors/examples/ingest/awaiting-amendments/` until A1
       lands; fixtures in `fixtures/connectors/ingest/` — good, empty, malformed (not JSON, wrong schema, wrong source,
       records not an array, nothing mappable), oversized, and the wrong token (the good envelope with another token,
       in the test). All invented, and the fixtures README says so. Plus `node-red-flow.json`, the flow to import.
4. [x] `docs/connectors/ingest.md`: the definition, settings, the token, the envelope, every answer, curl and
       PowerShell, the Node-RED flow, Source Health, what the listener will never do.
5. [x] `ingest.test.ts` (28 tests): the sidecar fixtures through the listener for both examples; the frozen suite's
       drivable checks; envelope validation; token (wrong, missing, never seen by the provider); caps (413, 429 with
       `Retry-After`); 404/405; the options the provider asks with (no address field exists to set — the runtime fixes
       127.0.0.1 — and the token by key only); lifecycle (cancel during the bind, stop, resubscribe, settings reopen,
       a busy port retried, a change during the first bind); health; the Node-RED flow's wiring.
6. [x] Changelog fragment `docs/roadmap/phases/changelog/ingest.md`; this status and the evidence.

## Definition of done

- [ ] `connector:test --all` green through the shim — `--all` is green (23/23), but the ingest examples are not in
      it: the suite has no listener mode (**A1**). Run directly, their five definition-level checks pass and the nine
      `query`-driven ones cannot run (evidence).
- [x] a real POST from curl, pasted below (the real `ProviderHost` and the runtime's real listener in the container;
      not from the app, and not from Node-RED).
- [x] `phase-check` passes; the common checks the container can run are green (ESLint and the Windows gate are the
      integrator's).

## Decisions

1. **The listener lives with the subscription**, not with `start()`: the host subscribes once the source runs, and a
   failed first bind (a port in use) is then retried by the host's own backoff, where a failed `start()` would not
   be. `listen` is offered while running, so this is inside the landed contract.
2. **Path from the id** (`/ingest/<id>`): the definition schema is frozen and has no ingest block, and the id is
   already unique and kebab-case. The envelope's `source` must equal it.
3. **Port and caps are provider settings** (`port`, `maxBodyBytes`, `maxRequestsPerMinute`), declared by the
   definition as number settings; unset means 47311, 1 MiB, 600/min. The validator refuses bounds wider than the
   listener's, and warns when there is no `port` setting (two sources cannot share one).
4. **Deltas, emitted per push** (`snapshot: false`), not batched: a push is already a batch, and the 202 then means
   the host has it.
5. **400 only when nothing could be taken**: a push where every record was rejected (none filtered) is 400 with the
   reasons; a partly good push is 202 with the counts and up to five reasons. Unknown envelope fields are refused, so
   a typo fails loudly.
6. **Health is republished by an empty delta** after every request the source answers and every settings outcome —
   the host publishes a subscription source's health only when it emits (found by the review).
7. **A reopen that fails is retried by the source** (2 s doubling to a minute): the host does not know a working
   subscription lost its listener after a settings change (found by the review).
8. **`STARTING` until the first push**, `LIVE` after; `DEGRADED` when a refused setting left the listener where it was.

## Design notes

- Records are snapshots per push? No: an ingest push is a delta (the pusher sends what
  changed). Use `snapshot: false` semantics — check what the provider host offers for
  non-snapshot batches (`ObservationBatch.snapshot`); if a subscription provider's emit is
  already delta, mirror `websocket-json`.
- Timestamps: the envelope may carry `observedAt` per record; absent → receipt time,
  flagged.
- The token is a credential; the settings UI shows "regenerate", never the value twice.

## Amendment requests

- **ADR-003: landed** (2026-09-23 amendment, integrator item #7). The shape differs from
  the request in two places, both to keep the token out of the provider:
  `context.local.listen?({ port, path, credential: { key }, maxBodyBytes?, maxRequestsPerMinute?, signal? },
handler: (req: { method, headers, body: Uint8Array, remote }) → { status, body?, headers? })`
  → `{ port, received, refused, close() }`. The runtime binds `127.0.0.1` itself and does the
  token comparison, the path/method/size/rate/Host refusals (404/405/413/429/421/401) before
  the handler is asked, and strips `Authorization` and `Cookie`; the handler sees only
  admitted requests. Offered to `local-process` providers only, one per source, closed on
  stop. Build against `testing.FixtureLocalAccess`: set `listenerSecrets[key]`, open with
  `listen`, drive with `simulateRequest({ token, body, path?, method?, headers? })` — the same
  admission rules (`ListenerGate`) as the app. No shim needed: start from `develop`.

- **A1 — ADR-013, `packages/connector-runtime/src/testing/suite.ts`: the suite's listener mode.** The suite drives
  a definition by `query` (HTTP), `FixtureSockets` (a `websocket` block) or a fixture granted folder (a `file` block);
  a pushed source has none of the three, so every data check fails with `provider.query is not a function`. The
  smallest change: when the provider's manifest is `local-process` and the definition has no `endpoint`, `websocket`
  or `file`, run the listener mode — `make()` passes a `testing.FixtureLocalAccess` with
  `listenerSecrets[<the definition's one credential>] = 'test-token'`, subscribes, and drives
  `simulateRequest({ token, body })`: _Successful parse_ = each `normal` body answered 2xx and
  `expectObservations`/`expectIds`/`verify` over what was emitted; _Empty response_ = 2xx, nothing emitted;
  _Malformed response_ = each `malformed` body 4xx, nothing emitted; _Auth failure_ = another token → 401 and nothing
  reached the handler; _Rate limit_ = past the listener's `maxRequestsPerMinute` → 429 with `Retry-After` (the
  fixture's `now`); _Oversized payload_ = a body over `maxBodyBytes` → 413, handler not called; _Cancellation_ =
  aborting the subscription closes the listener (`FixtureLocalAccess.listener.closed`); _Timeout_ has no equivalent
  (no request goes out) and can be "the listener opened" (`listener` present and open); _Mapping error_ = the broken
  mapping's push → 4xx. `ingest.test.ts` does exactly this today with the examples' sidecars (its first two tests),
  so the change can be lifted from there. When it lands: move the two examples up from `awaiting-amendments/`, delete
  its README, and drop test 3 ("drivable checks").
- **A2 — the app: generate the ingest token.** The brief wants a token "generated and shown once in the settings";
  the credential UI can only store a pasted value (`credentials.set`), and the connector cannot write a credential.
  Smallest change: for a credential of `kind: "token"` on a `local-process` source, Sources → Credentials offers
  "Generate" (32 random bytes, base64url, from the main process's CSPRNG), stores it, shows it once with a copy button,
  and afterwards only "Regenerate". Until then the guide says how to make one (PowerShell's
  `RandomNumberGenerator`, `openssl rand`).
- **A3 — ADR-003 / `provider-runtime`: republish health for a listener source.** The host publishes a subscription
  source's health on an emit, at start and when a subscribe fails. The provider now emits an empty delta whenever it
  answers a request, but two things never reach it: requests the host's listener refuses (401/404/405/413/421/429 —
  counted on the handle, shown at the next publish) and a credential change (`onCredentialChange` only reschedules a
  poll, and a source without `query` has none), so a source whose token is stored stays `AUTH_REQUIRED` in Source
  Health until the first push. Smallest change: in `withListener`, publish health (debounced, say once a second) after
  a refusal; in `onCredentialChange`, publish health for a running provider without `query`.

### For the integrator (not requests)

- **O1 — `packages/runtime/src/core.ts:495`**: the offline registry's `localAircraft` flag is true whenever any
  `local-process` provider runs, so an enabled ingest source makes the diagnostics report local aircraft. A heuristic
  in frozen code; it would want the transport plus an object type check.
- **O2 — a setting has no per-definition default value** (`ProviderSettingDefinition` has `defaultLabel` only), so
  every ingest definition defaults to 47311 and two enabled ones collide until the operator sets a port. The second
  one's health names the busy port; the guide says to set it. A `default` on number settings would let a definition
  pick its own.

## Evidence

All at `98b76c6` in the cloud container (Node 22.22.2, curl 8.5.0), on `develop @ 59d546d`. The brief and this
evidence are the next commit.

**Typecheck** (`node tools/dev/typecheck.mjs`, exit 0):

```
[typecheck] tsconfig.json (shims as on develop)
[typecheck] tsconfig.renderer.json (shims as on develop)
```

**Boundary** (`node tools/dev/boundary-check.mjs`): `[boundary-check] files=704 violations=0 → PASS`

**Tests** (`node tools/dev/run-tests.mjs`, exit 0; 1141 on develop, +28):

```
ℹ tests 1177
ℹ suites 0
ℹ pass 1169
ℹ fail 0
ℹ cancelled 0
ℹ skipped 8
ℹ todo 0
ℹ duration_ms 89312.211156
[tests] group=all files=195 pass=1169 fail=0 -> artifacts/verification/tests/all.json
```

**The phase's tests** (`ingest.test.ts`):

```
ok 1 - listener checks: node-red-weather-stations.json with its sidecar fixtures
ok 2 - listener checks: pi-soil-sensors.json with its sidecar fixtures
ok 3 - the frozen shared suite passes every check it can drive on the ingest examples (the rest wait for A1)
ok 4 - an oversized body is refused 413 before the provider reads it
ok 5 - past maxRequestsPerMinute the pusher gets 429 with a Retry-After
ok 6 - another path is 404 and another method 405, before the provider is asked
ok 7 - a push where no record maps is 400 with the reasons; a partly good push is 202 with the rejections counted
ok 8 - a record without observedAt carries the receipt time, flagged, and the answer says how many
ok 9 - a record timed in the future is rejected, not emitted
ok 10 - the provider names only a port and its own path: no address, the token by key, never the value
ok 11 - the handler never sees the Authorization header or the token
ok 12 - changing the port setting moves the listener; a bad port setting is refused with the reason
ok 13 - a port in use fails the subscription with the port named, and health says so
ok 14 - a subscription cancelled while its port is opening closes the listener it gets
ok 15 - a host without a listener refuses with UNSUPPORTED
ok 16 - stop closes the listener; a second subscription replaces the first
ok 17 - health: waiting, then the last push and the pusher, the refusals, and a missing token
ok 18 - a user agent with control characters is cleaned and shortened for health
ok 19 - envelope: the v1 envelope, a bare array, and every refusal with a reason
ok 20 - validation: pushed sources have no endpoint, one token, sane settings; warnings for the rest
ok 21 - manifest: a local-process source, token required, fail-closed policy, off by default, valid
ok 22 - the Node-RED example flow posts the envelope to the example source, and carries no token
ok 23 - every request the source answers, and every settings outcome, republishes health (an empty delta)
ok 24 - a reopen that fails (the new port in use) is retried until it opens
ok 25 - a settings change made while the first port opens is applied once it has opened
ok 26 - a request that reaches a listener being replaced gets 503
ok 27 - a body nested past the stack is a 400, not a 500
ok 28 - health after a restart describes the new run, not the last one
# tests 28
# pass 28
# fail 0
```

Each fix from the two reviews was checked against deliberately broken code (the emit made a snapshot, the source
check removed, the listener never closed, the all-rejected 400 removed, the overtaken bind not undone, no health
republish, no retry, no reset on start, no CANCELLED on a cancelled bind, no catch around the mapping, a double
emit): every one failed at least one test; the passing tests were restored after each.

**connector:test --all** (exit 0): 23 PASS, 0 FAIL — the 23 definitions on develop; the ingest examples
are not in it (A1). **connector:test on the ingest examples** (exit 1, as expected until A1):

```
FAIL connectors/examples/ingest/awaiting-amendments/node-red-weather-stations.json — node-red-weather-stations (http-ingest)
  node-red-weather-stations (http-ingest)
    Config validation    PASS  ok
    Successful parse     FAIL  provider.query is not a function
    Empty response       FAIL  provider.query is not a function
    Malformed response   FAIL  malformed[0]: expected MALFORMED, got TypeError: provider.query is not a function
    Timeout              FAIL  expected TIMEOUT, got TypeError: provider.query is not a function
    Auth failure         FAIL  expected AUTH, got TypeError: provider.query is not a function
    Rate limit           FAIL  expected RATE_LIMITED, got TypeError: provider.query is not a function
    Oversized payload    FAIL  expected TOO_LARGE, got TypeError: provider.query is not a function
    Cancellation         FAIL  expected CANCELLED, got TypeError: provider.query is not a function
    Mapping error        FAIL  expected MALFORMED, got TypeError: provider.query is not a function
    Missing fields       PASS  ok
    Attribution          PASS  ok
    Data policy          PASS  ok
    Rate policy          PASS  ok
    5 pass, 9 fail → FAIL
```

(`pi-soil-sensors` the same: 5 pass, 9 fail, the same nine.)

**Licence audit**: `0 errors, 0 warnings → PASS` · **todo report**: `[todo-report] files=624 markers=0` ·
**staged resources**: up to date · **phase-check** (`node tools/dev/phase-check.mjs ingest --base origin/develop`):

```
[phase-check] phase=ingest branch=phase/ingest base=origin/develop (59d546db0b) files=22
   connectors/examples/ingest/awaiting-amendments/README.md
   connectors/examples/ingest/awaiting-amendments/node-red-weather-stations.json
   connectors/examples/ingest/awaiting-amendments/node-red-weather-stations.test.json
   connectors/examples/ingest/awaiting-amendments/pi-soil-sensors.json
   connectors/examples/ingest/awaiting-amendments/pi-soil-sensors.test.json
 ~ docs/connectors/README.md  [shared]
   docs/connectors/ingest.md
   docs/roadmap/phases/changelog/ingest.md
 ~ fixtures/connectors/README.md  [shared]
   fixtures/connectors/ingest/node-red-flow.json
   fixtures/connectors/ingest/soil-sensors-array.json
   fixtures/connectors/ingest/weather-stations-empty.json
   fixtures/connectors/ingest/weather-stations-envelope.json
   fixtures/connectors/ingest/weather-stations-oversized.json
   fixtures/connectors/ingest/weather-stations-unmappable.json
   fixtures/connectors/ingest/weather-stations-wrong-source.json
   packages/connector-runtime/src/connectors/ingest/envelope.ts
   packages/connector-runtime/src/connectors/ingest/http-ingest.ts
   packages/connector-runtime/src/connectors/ingest/index.ts
   packages/connector-runtime/src/connectors/ingest/ingest.test.ts
 ~ packages/connector-runtime/src/index.ts  [shared]
 ~ packages/connector-runtime/src/registry.ts  [shared]
[phase-check] shared slot files touched: 4 (integrator reviews the slot lines)
[phase-check] PASS
```

**Format**: Prettier **3.8.1** (the container's; the repo resolves 3.9.8) passes on every file this phase changed; the
same 3.8.1 flags 24 files on a clean `develop`, none of them this phase's. **Not run**: ESLint (not installable here;
the code was read for `prefer-const`, unused names and useless escapes), Prettier 3.9.8, the Windows gate.

**A real push** — the real `ProviderHost` (`packages/provider-runtime`) with the runtime's real listener
(`createLocalListener`, `packages/runtime/src/support/local-listener.ts`) and this connector, the
`node-red-weather-stations` example with `port` 47391, driven by curl on the same machine. The harness is a scratch
script, not committed (the runtime is not a dependency of `connector-runtime`); the token was random per run and is
shown as `<token>`:

```
$ curl -X POST http://127.0.0.1:47391/ingest/node-red-weather-stations -H Authorization: Bearer <token> -H Content-Type: application/json -A curl-e2e/1.0 --data-binary @fixtures/connectors/ingest/weather-stations-envelope.json   # good envelope
{"accepted":3,"rejected":0,"filtered":0,"timedAtReceipt":0}
-> HTTP 202

Source Health after the good envelope: LIVE — listening on 127.0.0.1:47391/ingest/node-red-weather-stations; last push 2026-09-23T20:00:00.000Z from curl-e2e/1.0: 3 accepted, 0 rejected

$ curl -X POST http://127.0.0.1:47391/ingest/node-red-weather-stations -H Authorization: Bearer nope --data-binary @fixtures/connectors/ingest/weather-stations-envelope.json   # wrong token
{"error":"missing or wrong bearer token"}
-> HTTP 401

$ curl -X POST http://127.0.0.1:47391/ingest/node-red-weather-stations --data-binary @fixtures/connectors/ingest/weather-stations-envelope.json   # no token
{"error":"missing or wrong bearer token"}
-> HTTP 401

$ curl -X POST http://127.0.0.1:47391/ingest/node-red-weather-stations -H Authorization: Bearer <token> --data-binary @fixtures/connectors/ingest/weather-stations-wrong-source.json   # wrong source
{"error":"source \"some-other-source\" is not this listener's source \"node-red-weather-stations\""}
-> HTTP 400

$ curl -X POST http://127.0.0.1:47391/ingest/node-red-weather-stations -H Authorization: Bearer <token> --data-binary hello   # not JSON
{"error":"the body is not JSON"}
-> HTTP 400

Source Health after a body that is not JSON: LIVE — listening on 127.0.0.1:47391/ingest/node-red-weather-stations; last push 2026-09-23T20:00:00.000Z from curl-e2e/1.0: 3 accepted, 0 rejected; refused before the source: 401×2; last bad body 2026-09-23T20:00:00.000Z: the body is not JSON

$ curl http://127.0.0.1:47391/ingest/node-red-weather-stations -H Authorization: Bearer <token>   # GET
{"error":"only POST"}
-> HTTP 405

$ curl -X POST http://127.0.0.1:47391/ingest/other -H Authorization: Bearer <token> --data-binary []   # other path
{"error":"not the listener path"}
-> HTTP 404

$ curl -X POST http://127.0.0.1:47391/ingest/node-red-weather-stations -H Host: evil.example:47391 -H Authorization: Bearer <token> --data-binary []   # rebound Host header
{"error":"the Host header must be 127.0.0.1 or localhost with this port"}
-> HTTP 421

$ curl -X POST http://127.0.0.1:47391/ingest/node-red-weather-stations -H Authorization: Bearer <token> --data-binary @big.json   # 2 MiB body (cap 1 MiB)
{"error":"the body exceeds 1048576 bytes"}
-> HTTP 413

Source Health after the rest: LIVE — listening on 127.0.0.1:47391/ingest/node-red-weather-stations; last push 2026-09-23T20:00:00.000Z from curl-e2e/1.0: 3 accepted, 0 rejected; refused before the source: 401×2; last bad body 2026-09-23T20:00:00.000Z: the body is not JSON

health: LIVE — listening on 127.0.0.1:47391/ingest/node-red-weather-stations; last push 2026-09-23T20:00:00.000Z from curl-e2e/1.0: 3 accepted, 0 rejected; refused before the source: 401×2, 404×1, 405×1, 413×1, 421×1; last bad body 2026-09-23T20:00:00.000Z: the body is not JSON
batches reaching the host: [{"n":3,"snapshot":false,"ids":["backyard-01","roof-02","pier-03"]},{"n":0,"snapshot":false,"ids":[]},{"n":0,"snapshot":false,"ids":[]}]
listening sockets on :47391 while running:
0100007F:B91F

listening sockets on :47391 after the source is disabled: 0
listening log line: {"providerId":"node-red-weather-stations","address":"127.0.0.1:47391","path":"/ingest/node-red-weather-stations"}
log entries: 1 — token in any: false
```

`0100007F:B91F` is `127.0.0.1:47391` in `/proc/net/tcp` — the only listening socket on that port; none after the
source is disabled.

**Not verified**: a push from a real Node-RED (the flow is checked for shape and wiring only); the app itself (Sources
panel, settings UI, credential store) — the run above is the host and listener without Electron; Windows.

**Reviews**: an independent reviewer checked the branch at `b022015` against this brief, T16 and the phase rules,
with probes on the real host and listener. It found: Source Health almost never republished (fixed, decision 6); a
failed reopen never retried (fixed, decision 7); a settings change during the first bind lost; a cancel during the bind
resolving instead of throwing, leaking a settings listener; a deep body answered 500; a refused setting not shown;
health carrying the last run's push; A1/A2 not yet written here. All fixed at `592446d` with tests. A second pass over
`b022015..592446d` confirmed the fixes on the real host and found a deep value under a mapped key still answered 500,
a double publish per push, a queue that could stall on a rejected link and one guide sentence — fixed at `98b76c6`.
Its host-side findings are A3 and O1; the shared-port default is O2.
