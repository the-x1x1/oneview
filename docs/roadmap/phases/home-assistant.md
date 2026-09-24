# Phase `home-assistant` — Home Assistant

Status: complete at `240bdd7` (the work; this brief and its evidence are the commit after it), live run not yet done · Branch: `phase/home-assistant` · Target: 0.2.0 · Owner: session 01CwV9 (2026-09-24)

## Goal

Every entity in the operator's Home Assistant that has a position (device trackers, zones,
persons) or is a sensor at a known place (a weather station, an air-quality monitor, an
energy meter at home) is an object in the world, live, through Home Assistant's own APIs
and a long-lived access token.

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; ADR-003 (local transports,
`trustedHostSetting`); `packages/connector-runtime/src/connectors/websocket-json.ts` and
`rest-json.ts`; Home Assistant's REST API (`/api/states`) and WebSocket API
(`auth_required` → `auth` with token → `subscribe_events` `state_changed`).

## Scope

In: `home-assistant` — instance URL from `trustedHostSetting` (loopback or one host;
http allowed to loopback as the local policy says, https otherwise), the long-lived token by
credential reference (bearer header for REST; the `auth` frame for the socket — the
`{secret}` mechanism), initial `/api/states` snapshot then `state_changed` events, entity
selection by domain and glob (`device_tracker.*`, `person.*`, `zone.*`, `sensor.outdoor_*`),
positions from `attributes.latitude/longitude` or from a fixed position per entity or per
area (`positions` table, capped), attributes mapped to payload with unit conversion via
transforms, `sensor` and `weather-station` object types, friendly names as labels.

Out: controlling anything (no service calls, ever); camera streams (the camera gateway's
job); history API.

## Deliverables

1. [x] `packages/connector-runtime/src/connectors/home-assistant/{home-assistant,entities}.ts`,
       `index.ts`; slot lines (the registry's import and list entry, the package index, the docs
       index, the fixtures README).
2. [x] Examples with sidecars and fixtures under `connectors/examples/home-assistant/`,
       `fixtures/connectors/home-assistant/`: a states snapshot with trackers, persons, zones
       and sensors; a `state_changed` event stream; the auth handshake and its refusal. The
       examples are zones, weather and sensors. Trackers and persons are in the fixtures only to
       prove they are never read (decision 1).
3. [x] `docs/connectors/home-assistant.md`: creating the token, the URL, what is read and
       what is never sent.
4. [x] `home-assistant.test.ts`: the suite on every example (the REST snapshot) plus the
       socket path driven directly, because the suite's socket mode needs a `websocket` block
       that a local definition cannot have (observation 1). Also entity selection, auth failure
       (`401` and `auth_invalid`), reconnect resubscribes, and the frame allow-list checked over
       every socket in the file.
5. [x] Changelog fragment; status and evidence.

## Definition of done

- [x] `connector:test --all` green
- [ ] a live run against a real instance pasted (the operator's, on the LAN) — the steps are
      under "Live run" in Evidence
- [x] a test proves no frame other than `auth`, `subscribe_events` and `ping` is ever sent
- [x] `phase-check` passes; all common checks green (format and lint cannot run in the
      container; see Evidence)

## Design notes

- The socket needs a `ws://` to loopback or the trusted host; the schema's `wss`-only rule
  is for public hosts. Check whether `websocket.url` validation applies the local policy
  when `trustedHostSetting` is set; if not, that is a small amendment request (ADR-013).
- `state_changed` events carry `new_state`; map that, keep `old_state` out of the payload.
- Persons without a tracker have no position; skip with a filter, not a rejection.

## Decisions

1. **`person` and `device_tracker` are never read (open question for the operator).** The
   Goal and Scope name device trackers and persons, but the binding constraints (§73) and
   `docs/PRODUCT-BOUNDARIES.md` forbid "private-device tracking (phones, personal
   vehicles, consumer trackers)" and following a named person, and the constraints outrank a
   brief. Both domains are in `REFUSED_DOMAINS`. Their states are dropped as they arrive
   from `/api/states` and from the socket: never kept, mapped or emitted, whatever a filter
   or the Entities setting selects. A definition that names them validates with a warning.
   If the operator decides that their own household's trackers are in scope, it is one line
   (`entities.ts`) and one test to change. That decision is theirs, not a phase's.
2. **The address is settings, not definition.** The definition schema allows only https/wss
   to a public host, and a Home Assistant is on the LAN. So the connector builds its own
   manifest (`homeAssistantManifest`): `transport: 'local-process'`, `allowedHosts`
   loopback, `trustedHostSetting: 'host'`, and the settings `host` (empty = this computer),
   `port` (8123) and `tls`, resolved by `resolveLocalEndpoint`. A definition with
   `endpoint` or `websocket` is refused, so a definition never holds an address. The token
   is the definition's one declared credential, marked required.
3. **Entity patterns and positions are settings.** The definition schema is strict and has
   no connector-specific block, so the `entities` (globs) and `positions`
   (`<pattern>=<lat>,<lon>` or `=zone.<name>`, at most 64) tables are string settings the
   Sources panel can edit. Domain and attribute selection is the definition's mapping filter.
   Derived fields (`_domain`, `_position`, `_home`, `_si`, …) give the mapping what it needs
   without any expression language.
4. **"Per area" is a zone reference.** `/api/states` carries no area. Reading the area
   registry would need a frame beyond the three allowed, so the Positions setting takes
   `zone.<name>`, and a definition may fall back to `zone.home` (`_home`).
5. **Home location as a declared fallback.** The weather and sensors examples map
   `{"latLon": {"path": "_position", "fallback": "_home"}}`, so a station or an energy
   meter at home is placed there. The zones example does not fall back. An entity with no
   position is rejected and counted in Source Health.
6. **The auth frame goes out in `onOpen`.** The host hands the token to `onOpen` and to
   nothing else, and the provider must not keep it. So `auth` is sent on open instead of
   after `auth_required`; Home Assistant reads the client's first message after sending
   `auth_required`. This ordering is unverified against a live instance (see Evidence).
7. **Units through the registry.** `_si` converts only when Home Assistant states the
   unit (`unit_of_measurement`, or a weather entity's `*_unit`), and only through
   `resolveTransform` (`fahrenheitToCelsius`, `scale:<n>` …). A value with no stated unit is
   left out, not assumed.
8. **Two paths, one snapshot.** `query` reads `/api/states` on the first poll and whenever
   the socket is not live. While the socket is live it answers from the states the socket
   keeps, and reads again after every (re)subscription and every ten minutes. The socket's
   `state_changed` batches are incremental; a removed entity leaves the next snapshot.
   Polling is once a minute.
9. **A refused token is final until something changes.** `401` stops the host's polling
   (AUTH), and `auth_invalid` stops the socket with no reconnect, because Home Assistant can
   ban an address after repeated failed logins. A socket the host will not open
   (HOST_NOT_ALLOWED — `ws://` on this build) leaves REST in charge and is asked for again
   every 15 minutes.

10. **Plain HTTP to the trusted host is allowed; TLS is a setting, off by default.** The
    Scope says "http allowed to loopback as the local policy says, https otherwise". The
    local-endpoint policy (ADR-003 `trustedHostSetting`, `resolveLocalEndpoint`, the HTTP
    client) allows plain HTTP to exactly the one host the operator names as well as to
    loopback, and a Home Assistant on a LAN answers plain HTTP unless the operator has put
    TLS in front of it. Requiring https for the trusted host would leave most installations
    unreadable. So `tls` is off by default, and both the setting's description and the guide
    say that without it the token crosses the network in clear.
11. **Zones say where they are, not who is in them.** A zone's state is the number of people
    in it and its `persons` attribute is which people; its update times move when someone
    arrives or leaves. `readState` drops all three wherever a state enters, so zones carry the
    time of the read (`fetch-time`), and a `state_changed` event that changes only who is in
    a zone emits nothing. Found by the independent review; same boundary as decision 1.
12. **Selection fails closed; bad settings do not stop polling.** An Entities setting with no
    valid pattern selects nothing (it never falls back to everything). An invalid host is
    UNSUPPORTED rather than HOST_NOT_ALLOWED, because the host stops polling for good on
    HOST_NOT_ALLOWED and the corrected setting would never be read.

## Amendment requests

- **Integrated (2026-09-24):** merged at `ffdca00`. Request 1 (`ws://` to loopback or the trusted host) and 2 (`connector:test --live --setting`) are open; the plain-HTTP fallback to `/api/states` once a minute is in. The `person`/`device_tracker` refusal waits for the operator's decision.

1. **ADR-003 — `ws://` to loopback or the trusted host for local sources.** Needed for a
   live socket to an instance on plain HTTP, which is most of them. `ProviderHost.openSocket`
   refuses anything but `wss:` (and an offline application), while the HTTP client already
   allows `http:` to loopback and the trusted host, and `mqtt`/`openLineStream` allow
   exactly that pair for local transports. The smallest change is to let `openSocket`
   accept `ws:` when the manifest's transport is `local-process` or `hardware` and the host
   is loopback in `allowedHosts` or exactly the trusted host; not to refuse such a socket
   for `online === false`; and to keep `wss:` as it is. Tests: `ws:` to the trusted host
   opens, `ws:` to any other host is HOST_NOT_ALLOWED, and `ws:` from a `websocket`-transport
   provider is still refused. Until it lands, a plain-HTTP instance runs on `/api/states`
   once a minute and says why in Source Health; with `tls` on, the socket works today. When
   it lands, no change is needed here.
2. **`connector:test --live --setting key=value` (tools/connector-validator, low
   priority).** `runLive` gives every source empty settings, so the live check can reach an
   instance only on the machine it runs on. A repeatable `--setting` flag, parsed into the
   `MemorySettings` it already builds, would let the operator point it at a LAN host.
3. **ADR-013 — connector options in a definition (optional, not needed by this phase).**
   A strict schema leaves a connector's own configuration to settings, so a preset
   definition cannot ship defaults for them (entity patterns, a positions table — `mqtt`'s
   brief wants the same `positions` table in the definition). A `connectorOptions` JSON
   object, validated by the connector named in `connector`, would do it.

## Observations for the refactor pass

1. The suite chooses its socket mode by `definition.websocket`, which a connector whose
   socket URL comes from settings cannot have. Here the suite runs on the REST snapshot and
   the socket checks (successful parse, empty, malformed, cancellation, reconnect) are
   driven directly in `home-assistant.test.ts`.

## Evidence

Built on `origin/develop` @ `59d546d` (release 0.1.6, on GitHub). Every check below was run in
the phase's cloud container on the tree committed as `240bdd7`.

**Run and green:**

- `node tools/dev/typecheck.mjs`: exit 0 (both tsconfigs, container shims). Also
  `tsc -p packages/connector-runtime --noUnusedLocals --noUnusedParameters`: exit 0.
- `node tools/dev/boundary-check.mjs`: `files=704 violations=0 → PASS`.
- `node tools/dev/run-tests.mjs`: `tests 1184, pass 1176, fail 0, skipped 8` (the natives the
  container cannot load). `home-assistant.test.ts` is 35 of them, all passing:
  - the shared suite on each of the three examples (14/14 checks each);
  - the examples' policy (user-configured, disabled, no data policy, no address, no secret);
  - the manifest and the address;
  - validation;
  - the REST request shape and the token reference;
  - person/device_tracker refusal;
  - entity selection and positions;
  - REST errors, and recovery after a corrected host;
  - the socket handshake, events, removal, memory answers and resync;
  - `auth_invalid`;
  - reconnect with back-off and resubscribe;
  - ping and silence;
  - an unanswered auth;
  - malformed messages and cancellation;
  - a socket the host refuses;
  - a change of address;
  - frames of an old connection;
  - entity parsing, glob matching (with a pathological pattern) and unit conversion;
  - an event during an in-flight resync;
  - a read in flight across an address change (success and 401);
  - auth recovery, once;
  - zones without presence;
  - fail-closed Entities;
  - the entity cap and refused ids in messages;
  - last, every frame and request the file's providers made: only `auth`, `subscribe_events`
    (`state_changed`) and `ping`, and only `GET /api/states`.
- `node --import tsx tools/connector-validator/src/cli.ts --all`: exit 0, 26 definitions PASS
  (the three `home-assistant-*` at 14/14).
- `node --import tsx tools/license-audit/src/cli.ts`: `0 errors, 0 warnings → PASS`.
- `node --import tsx tools/dev/todo-report.mjs`: `files=624 markers=0`.
- `node tools/dev/stage-resources.mjs --check`: exit 0, up to date.
- `node tools/dev/phase-check.mjs home-assistant --base origin/develop`: `PASS` (21 files,
  4 shared slot files).
- Mutation checks: each of these breaks the named tests, and the tree was restored after:
  - emptying `REFUSED_DOMAINS` (3 fail);
  - sending a `call_service` frame in place of `ping` (2 fail);
  - ignoring entity removal (1 fail);
  - retrying after `auth_invalid` (1 fail).
- An independent reviewer (a separate agent that had not seen the work) checked the branch
  against this brief and the constraints twice. First pass: 15 findings. A pattern with many
  `*` froze the matcher for 50 s. A resync undid newer socket events. A read in flight across
  an address change was kept. A socket auth failure never cleared. A bad host stopped
  polling for good. Zones leaked who was present. Entities failed open. The cap truncated
  silently. `K` was converted for colour temperatures. Conversions were unrounded, plus test
  gaps. All fixed, with tests. Second pass: every fix confirmed, and one new bug found (an
  old address's 401 charged to the new one) — fixed, with a test.

**Not run, or not verifiable here:**

- **Format.** The container has Prettier **3.8.1**, not the gate's 3.9.8 (the operator's
  `prettier-3.9.8.tgz` could not be reached from this session). Every file of the phase
  passes 3.8.1's `--check`. Constructs where 3.8.1 and 3.9.8 are known to differ (long union
  types) were written so both agree. The only file 3.8.1 flags under `packages/connector-runtime/src` is `files/kml.ts`,
  which this phase does not touch and 3.9.8 accepts. The Windows gate is the real check.
- **Lint.** ESLint is not installed in the container. The files were written for the rules
  that have bitten before (`prefer-const`, unused variables with `^_`, `no-useless-escape`),
  and the tsc unused check above passes.
- **A live instance.** Nothing here has talked to a real Home Assistant; the fixtures are
  invented in the APIs' published shapes. Unverified until a live run:
  - that Home Assistant accepts the `auth` frame sent on open, before `auth_required`
    (decision 6);
  - the `/api/states` and event shapes of a current release;
  - that a non-administrator token may subscribe to `state_changed`.

**Live run** (the operator's, when the branch is fetched into a worktree — never the main
checkout). `connector:test --live` passes no settings (amendment request 2), so from the
command line it reaches only `127.0.0.1:8123`. Either run it on the machine Home Assistant
runs on, or forward the port first (for example `ssh -N -L 8123:<ha-host>:8123 <user>@<ha-host>`
with Home Assistant's SSH add-on), then:

```
$env:ONEVIEW_SECRET_HOME_ASSISTANT_TOKEN = '<long-lived token>'
pnpm connector:test connectors/examples/home-assistant/home-assistant-zones.json connectors/examples/home-assistant/home-assistant-weather.json connectors/examples/home-assistant/home-assistant-sensors.json --live *>&1 | Tee-Object -FilePath $HOME\Downloads\wv-build\home-assistant-live.log
Remove-Item Env:ONEVIEW_SECRET_HOME_ASSISTANT_TOKEN
```

Expected: `live: LIVE — reading /api/states once a minute; the WebSocket API is not available
here (…)` and a sample observation per definition (a live `--live` listens to a socket
definition only when it has a `websocket` block, so the socket path is not exercised by the
CLI). After integration, the in-app check is the same with the source's `host` set to the LAN
address. With `tls` on and https in front of Home Assistant, Source Health should read "live
over the WebSocket API".
