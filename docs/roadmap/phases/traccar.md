# Phase `traccar` — Traccar

Status: complete at `9b15206` (brief and evidence in the commit after it) · Branch: `phase/traccar` · Target: 0.2.0 · Owner: session 01NEXs (2026-09-24)

## Goal

A Traccar server — the open-source GPS tracking platform most fleets, families and
hobbyists run for their own trackers — becomes a source: its devices as objects with
live positions, speed, course, battery and the events Traccar raises.

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; `docs/connectors/REST-JSON.md` and
`WEBSOCKET.md`; Traccar's API (`/api/session` cookie or bearer token, `/api/devices`,
`/api/positions`, `/api/socket` WebSocket sending `{ devices, positions, events }`).

## Scope

In: `traccar` — server URL (public https, or loopback/trusted host by the local policy),
a token by credential reference (bearer), an initial `/api/devices` + `/api/positions`
snapshot then the socket's `positions` messages (the `websocket-json` shape with a
`{secret}` … no: Traccar authenticates the socket by the session cookie or `?token=`;
support `token` as a query credential on the socket URL — see amendment), device names and
categories as labels, `speed` (knots → m/s), `course`, `altitude`, `attributes.batteryLevel`,
`attributes.ignition`, `motion`, `protocol`; events (`geofenceEnter`, `alarm`, …) as payload
of the device's latest observation, not as separate objects (this release).

Out: geofence management, commands to devices, reports/history export.

## Deliverables

1. [x] `packages/connector-runtime/src/connectors/traccar/{traccar,session}.ts`, `index.ts`;
       slot lines (registry import + list entry, package index, docs and fixtures READMEs).
2. [x] Examples with sidecars and fixtures under `connectors/examples/traccar/`,
       `fixtures/connectors/traccar/`: devices, positions, socket messages, an event.
       `traccar-demo-live.json` (REST + socket), `traccar-demo-rest.json` (REST only),
       `traccar-local.json` (a server on this computer or the named host); fixtures invented in
       the published shape.
3. [x] `docs/connectors/traccar.md`.
4. [x] `traccar.test.ts`: suite; snapshot + socket merge; knots conversion; auth failure —
       37 tests in all.
5. [x] Changelog fragment (`changelog/traccar.md`); status and evidence.

## Definition of done

- [x] `connector:test --all` green (26/26, the three traccar examples included)
- [ ] a live run against a Traccar demo server or the operator's pasted — **not run**: the
      container's proxy refuses public hosts, and a demo-server account and token are the
      operator's (block below)
- [x] `phase-check` passes; every common check the container can run is green (lint is
      not runnable here; Prettier ran as 3.8.1, not the gate's 3.9.8 — see Evidence)

## Design notes

- Positions arrive per device with `deviceId`; join with the devices snapshot for the name
  (refresh the snapshot every few minutes; a position for an unknown device is kept with the
  id as its label).
- `fixTime` is the observation time, `serverTime` the receipt; use `fixTime`.
- Object type: `transit-vehicle` for vehicles, `sensor`/`place` otherwise — the definition
  chooses; default `transit-vehicle`.

## Decisions

- **One record per position for the definition's own mapping.** The connector does not
  hard-code a mapping: each position is Traccar's position object plus `deviceName`,
  `device` (`id, name, category, status, model, disabled, lastUpdate`) and `event`
  (`type, eventTime, positionId, geofenceId, alarm`), so the definition chooses the object
  type, labels and properties, and the shared suite's mapping checks apply unchanged.
- **Devices in Traccar's `person` category are left out**, and a device's `uniqueId`,
  `phone`, `contact` and a position's `attributes.driverUniqueId` never reach a record
  (docs/PRODUCT-BOUNDARIES.md: not a people-tracking system; no private-device tracking).
  This fails closed: nothing is shown until one whole device list has been read (a first
  list that fails fails the poll; socket positions of devices nothing has described are
  held). The brief's "a position for an unknown device is kept with the id as its label"
  applies after that, to a device added since the last list. **For the operator:** the
  category is all the connector can see; a phone running the Traccar client in any other
  category is shown. Whether a Traccar source should carry more than that guide's warning
  is a product call, not made here.
- **Events ride on the position they belong to** (the one they name, or one no newer), are
  re-sent on the device's last position when they arrive alone (same `fixTime`), and are
  cleared by the next fix when the definition maps them with `"default": null` (the live
  example does). Only the socket carries events; the REST and local examples map none. A
  re-send adds one more track point at the same time in the state engine (accepted); an
  event whose position was overtaken before it arrived is kept but not shown.
- **REST keeps running under the socket** at `endpoint.intervalSeconds` (300 s in the live
  example), refreshing the snapshot and the names; the device list is re-read every five
  minutes (a minute after a failure). A socket that drops or will not open is retried by
  the provider with back-off from 2 s to a minute (only for offline, network, timeout, DNS
  and 5xx); the host's own retry of a failed subscription shares its timer with the poll
  and would be lost (see request 3).
- **A local server** is a definition without `endpoint`: `http://127.0.0.1:8082` or the
  host named in the `host` setting (the manifest's `trustedHostSetting`) at the `port`
  setting, `local-process` transport, REST every 30 s, token in `credentials.token` as a
  bearer token. No socket: the host opens `wss://` to public hosts only (request 1).
- **The shared suite's REST fixture is a device and its position in one object**
  (`suite-combined.json`, labelled as not a Traccar answer), because the suite serves one
  body to every request (request 2); `traccar.test.ts` answers `/api/devices` and
  `/api/positions` separately for everything else.
- The token on the socket: Traccar's API page says the session cookie is the only way to
  authenticate `/api/socket`; its developer has said on the forum that `?token=` works.
  Unverified here. If a server refuses it, the source is DEGRADED and the poll carries on.

## Amendment requests

- **Integrated (2026-09-24):** merged at `389df17`. Requests 1 (`ws://` for local sockets, shared with home-assistant), 2 (per-URL suite fixtures, with ogc's 3), 3 (the host's subscription retry sharing `h.timer` with the poll; doubled back-off in `websocket-json`) and 4 (a refused upgrade reaching providers as a plain close) are open for the refactor pass.

- **ADR-003 / ADR-013 (socket credential in the URL query): landed** (2026-09-23
  amendment, integrator item #10). `websocket.credential: { name, as: "query", param? }` in
  a definition — or `ProviderSockets.open(url, events, { credential: { key, as: 'query',
param } })` from a provider — has the host append `param=<secret>` (`token` by default)
  to the URL it dials; `onOpen` gets no secret and no log or health line carries the URL.
  `testing.FixtureSockets` records the dialed URL (`opened[n].url`). The REST path
  (`/api/positions`) remains the fallback for a server whose socket refuses the token.
  Used as landed; no shim.

New requests from this phase (none blocks it):

1. **ADR-003 (local sockets), same as `home-assistant`'s:** `ProviderSockets.open` accepts
   `wss:` to allowlisted hosts only, so a Traccar server on loopback or the trusted host is
   read by REST alone. Smallest change: for a `local-process` provider, also accept `ws:`
   to loopback in `allowedHosts` or the trusted host, as the HTTP client already does for
   `http:`; the definition schema's `wss`-only rule would then need a local form too.
2. **ADR-013 (the suite), same as `ogc`'s request 3:** per-URL fixtures in
   `runConnectorSuite` (a responder keyed by path, or a sidecar map), so a connector that
   makes two different requests per poll is tested with real answers, not
   `suite-combined.json`.
3. **ADR-003 (the host):** `openSubscription`'s retry after a failed `subscribe` sits in
   `h.timer`, which `schedule()` (the poll) clears; a provider with both `query` and
   `subscribe` never gets that retry. This connector retries itself; a separate timer in
   the host would fix it for everyone. Also: the host reports one socket failure as
   `onError` then `onClose`, which `websocket-json` (frozen) treats as two drops, doubling
   its back-off — the same guard as here (one drop per connection) would fix it there.
4. **ADR-003 (socket auth):** a refused WebSocket upgrade (HTTP 401/403) reaches the
   provider as an error and a close, so a socket that refuses the token cannot be told
   from a dropped one: it shows DEGRADED/OFFLINE and is redialled. Passing the upgrade's
   HTTP status (as a `ProviderError('AUTH')` from `open`, or on `onClose`) would let it
   stop and say AUTH_REQUIRED.

## Evidence

Container checks at `9b15206` (2026-09-24, cloud container, Node 22.22.2, local toolchain
linked because the registry refuses `pnpm install`):

```
node tools/dev/typecheck.mjs                                   exit 0 (shims in use, as always here)
node tools/dev/boundary-check.mjs                              [boundary-check] files=704 violations=0 → PASS
node tools/dev/run-tests.mjs                                   ℹ tests 1186 · pass 1178 · fail 0 · skipped 8 (natives)
node --import tsx --test …/traccar/traccar.test.ts             # tests 37 · pass 37 · fail 0
node --import tsx tools/connector-validator/src/cli.ts --all   exit 0 — 26 PASS, 0 FAIL
  traccar-demo-live (traccar)   10 pass, 0 fail → PASS   (socket suite)
  traccar-demo-rest (traccar)   14 pass, 0 fail → PASS
  traccar-local (traccar)       14 pass, 0 fail → PASS
node --import tsx tools/license-audit/src/cli.ts               0 errors, 0 warnings → PASS
node --import tsx tools/dev/todo-report.mjs                    [todo-report] files=624 markers=0
node tools/dev/stage-resources.mjs --check                     up to date
node tools/dev/phase-check.mjs traccar --base origin/develop   files=23 … shared slot files touched: 4 → PASS
git log origin/develop..HEAD: every commit the-x1x1 <connersalt123@outlook.com>, no trailers; the handbook's name check (git grep) prints nothing
```

- **Prettier:** the gate's `prettier-3.9.8.tgz` was not reachable from this session. The
  container's Prettier 3.8.1 passes every file this phase touches; over the whole repo it
  flags 24 files, none of them this phase's (they are on `develop` as it is, and 3.9.8 is
  what the gate runs). Run `pnpm format:check` on Windows.
- **Lint:** not run (eslint is not installed here). Written for `prefer-const`,
  `no-unused-vars` (the one unused binding is `_driver`) and `no-useless-escape`; the
  reviewer read for them too.
- **Tests checked against broken code:** each of these edits makes at least one test fail
  (tried, then restored): no `person` exclusion; device-list errors fatal; no re-send on an
  event; the socket token as `open`; a phone number leaking; the device list read every
  poll; no hold before the first list; one failure dropping the socket twice; no retry of a
  socket that could not open; events on every later fix; no reset on a settings change; a
  dial after an abort; no race guard; retrying every open failure; the last fix in a
  message or a flush winning; the live example's event fields without `default: null`.
- **Independent review:** a reviewer subagent read the diff against this brief, ADR-013,
  PARALLEL-PHASES and the constraints twice. First pass: 13 findings (fail-open `person`
  exclusion when the device list was missing, a socket never retried after a failed first
  open, double drops, auth messaging, validation gaps, events overclaimed for REST, old
  events on later fixes, stale data after a settings change, a dial after abort, the
  driver id, the brief, test gaps) — fixed in `1a44a82`. Second pass: a typecheck
  regression in a new test, events not cleared on the object, a settings/poll race, retry
  of unfixable open failures, health wording, test gaps — fixed in `43d6008`/`9b15206`.
  Left as documented: re-sends add a track point at the same time; an event overtaken
  before it arrives is not shown; no test drives `query()` and `subscribe()` through the
  real `ProviderHost` (connector-runtime does not depend on provider-runtime, and adding
  that is a dependency change).
- **Not verified:** a live Traccar server (REST or socket), `?token=` on a real
  `/api/socket`, the Windows gate, ESLint, Prettier 3.9.8.

Live run, for the operator (needs an account and token on a demo server, e.g.
<https://demo.traccar.org>, Settings → Preferences → Token; the output goes to a file):

```powershell
# after `git push origin phase/traccar`; a separate worktree, so the main checkout is not touched
cd C:\Users\jconn\worldview
git fetch origin
git worktree add --detach ..\wv-traccar origin/phase/traccar
cd ..\wv-traccar; pnpm install --frozen-lockfile
$env:ONEVIEW_SECRET_TRACCAR_DEMO_TOKEN = '<token>'
pnpm connector:test connectors/examples/traccar/traccar-demo-rest.json connectors/examples/traccar/traccar-demo-live.json --live *>&1 | Tee-Object -FilePath $HOME\Downloads\wv-build\traccar-live.log
Remove-Item Env:ONEVIEW_SECRET_TRACCAR_DEMO_TOKEN
```
