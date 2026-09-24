# Phase `mqtt` — MQTT connector and the rtl_433 preset

Status: building (session cff7b7e8, 2026-09-24) · Branch: `phase/mqtt` · Target: 0.2.0 · Owner: session cff7b7e8

## Goal

A broker on the operator's network — Mosquitto, EMQX, the one inside Home Assistant —
carrying JSON payloads from sensors, trackers, OwnTracks phones, Meshtastic gateways and
`rtl_433` becomes a source: subscribe to topics, map each message. `rtl_433 -F mqtt` is the
first preset (its JSON is well known: `model`, `id`, `time`, `temperature_C`, …).

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; ADR-003 (local transports,
`trustedHostSetting`, the local-endpoint policy);
`packages/connector-runtime/src/connectors/websocket-json.ts` (the subscription shape:
sessions, reconnect, flush batching, filter, health — mirror it);
`providers/weatherlink-local` (a local device provider).

## Scope

In: `mqtt` — broker host from `trustedHostSetting` (loopback or the one host the operator
names; TLS optional on 8883; username/password by credential reference), topic filters with
`+`/`#`, QoS 0/1, JSON payloads (a non-JSON payload is a record `{ raw, topic }`), the
topic itself available to the mapping as `_topic` and its segments as `_topic[n]`, retained
messages accepted once, reconnect with back-off, flush batching, health. Position sources:
the payload (`lat`/`lon`), or a fixed position from the definition's settings for a
stationary sensor (`position.fixed`), or a per-device table in the definition
(`positions: { "<id>": [lat, lon] }`, capped). Preset definitions: `rtl_433` (models with
temperature/humidity/pressure/wind/rain → `weather-station` or `sensor`), OwnTracks,
Meshtastic MQTT gateway (`msh/…` JSON), a generic GPS tracker payload.

Out: publishing; MQTT 5 features beyond what the client needs; bridging; WebSocket-MQTT.

## Deliverables

1. [x] Amendment request written first (below). The transport (ADR-003 #4) had landed
       before the phase started, so there is no `ProviderMqtt` shim: the connector runs on
       `context.mqtt` and is tested with `testing.FixtureMqtt`. Two further amendments are
       requested (M1, M2 below); their exact shapes are in `mqtt/contract.ts` and
       `mqtt/testing/suite.ts`.
2. [x] `packages/connector-runtime/src/connectors/mqtt/{mqtt,topics,presets}.ts`, `index.ts`
       (+ `contract.ts`, `testing/suite.ts`); registry and index slot lines.
3. [x] Examples with sidecars and fixtures under `connectors/examples/mqtt/awaiting-amendments/`
       (moved up one level when M1 and M2 land), `fixtures/connectors/mqtt/`: rtl_433 weather
       stations and sensors (five models in one run), OwnTracks, Meshtastic, a generic GPS tracker.
       Fixtures are invented in each format's published shape (no broker to record from).
4. [x] `docs/connectors/mqtt.md`: broker settings, TLS, credentials, topics, position options,
       the presets, health, what is never done.
5. [x] `mqtt.test.ts`: the suite (MQTT mode) on every example; topic matching; the definition
       block; retained handling; fixed and table positions; reconnect and back-off; presets.
6. [x] Changelog fragment (`changelog/mqtt.md`); status and evidence.

## Definition of done

- [ ] `connector:test --all` green on the MQTT examples — **waits for M1 and M2**. Until
      then the same checks run through the suite's MQTT mode in `mqtt.test.ts` (green, see
      Evidence), and `connector:test --all` is green on the 23 definitions it reaches.
- [ ] a real-broker run pasted once the amendment lands (Mosquitto on the operator's machine).
      Not done: the container has no broker and the registries refuse one. What was run
      instead: the provider through the runtime's real client over loopback TCP against a
      scripted broker (Evidence). That is not a Mosquitto run.
- [x] `phase-check` passes; every container check green (Prettier and ESLint: see Evidence)

## Design notes

- rtl_433 topic layouts vary (`rtl_433/<host>/devices/<model>/<id>/<field>` per-field vs
  `rtl_433/<host>/events` JSON); support the events JSON first, per-field topics as a
  documented limitation.
- Device identity: `model` + `id` (+ `channel`) → externalId; without a position the sensor
  needs `position.fixed` — say so in Source Health's message rather than dropping silently.
- Never write the broker password into a log; the credential store holds it.

## Decisions

1. **The broker host is never in a definition.** It is the operator's `brokerHost` setting,
   which is the manifest's `trustedHostSetting`. When it is empty the broker is `127.0.0.1`,
   by address, because Windows resolves `localhost` to `::1` first (environment traps). The
   manifest is `transport: 'local-process'` with `allowedHosts: ['127.0.0.1', 'localhost']`,
   so the runtime's own check (loopback in `allowedHosts`, or exactly the trusted host)
   applies unchanged. A changed `brokerHost` reconnects at once.
2. **`_topic[n]`.** The path grammar indexes arrays only, so every record carries `_topic`
   (the name) and `_topicLevels` (the levels), and the connector rewrites a path beginning
   `_topic[` to `_topicLevels[` in the mapping and in `mqtt.filter`. Definitions write
   `_topic[n]` as the brief says.
3. **Positions without touching the mapping's transforms.** Each record is mapped as the
   definition says. A record that maps but has no position or geometry is looked up by its
   external id in `mqtt.positions` (own keys only), then placed from `position.fixed`. It is
   then mapped again with `position: _position.lat/_position.lon`, so a transform on the
   payload's own latitude (Meshtastic's 1e-7) never touches a table position. Such an
   observation carries the flag `configured-position`. `position.fixed` applies only to a
   stationary source, one whose mapping has no position or geometry: a tracker or mesh node
   without a fix yet is never pinned to the operator's point (independent review, finding 3).
   A record with no position is counted, and the last five device ids are named in Source
   Health, with a message that fits the source (stationary: set position.fixed or add to
   mqtt.positions; moving: not reported a position yet).
4. **Retained once** means a retained copy of the payload last seen on the topic, live or
   retained, is not mapped again (a SHA-256 of the payload per topic, 4096 topics, least
   recently heard forgotten first). A live delivery of a retained publish arrives without
   the flag, so live messages count too. A new retained value is mapped. Retained
   observations carry `origin: cached`.
5. **Presets are a closed registry** (`presets.ts`) that add `_`-prefixed fields and never
   change the source's own fields. rtl_433 and Meshtastic merge readings per device (4096
   devices, least recently heard forgotten first), because an Acurite 5-in-1 and a Meshtastic
   node spread one device's state over several messages. rtl_433's `_class`
   (`weather-station` for wind or rain, `sensor` for temperature/humidity/pressure/moisture/
   light, `other`) lets one topic feed two definitions with different object types.
6. **Only unambiguous times.** rtl_433's default time is the receiver's local time with no
   zone. The preset reads Unix seconds and times with `Z` or an offset, and nothing else, so
   such a record is dated on arrival and flagged `fetch-time` rather than being hours out.
   The guide tells the operator to run `-M time:unix` or `-M time:iso:tz`.
7. **Meshtastic text is never read.** Only `position`, `nodeinfo` and `telemetry` packets
   become records. A test checks that a text packet's words appear in no observation.
8. **OwnTracks and the generic tracker — an exception to §73 decided by the operator.**
   `docs/PRODUCT-BOUNDARIES.md` rules out private-device tracking, phones included. Asked
   whether to build these two presets, the operator (2026-09-24) chose "build them, own
   devices": they are for devices the operator owns, reporting to the operator's own broker,
   and the guide says so. Nothing else about the boundary changes: there is no person
   search, no discovery, and no broker other than the operator's.
9. **Status for a host without the transport** is `ERROR` with a message starting
   `UNSUPPORTED:` (a `ProviderStatus` has no UNSUPPORTED). The subscription throws
   `ProviderError('UNSUPPORTED')`.
10. **Tyre-pressure sensors are never a sensor.** rtl_433's TPMS decoders report pressure and
    temperature, but the tyre belongs to a car driving past. The preset classes anything
    with `type: "TPMS"` (or TPMS in the model) as `other`, so no definition filtering on
    `sensor` or `weather-station` picks them up (docs/PRODUCT-BOUNDARIES.md; review
    finding 5).
11. **Examples wait one level down**, as `files` did: `connector:test --all` reads
    `connectors/examples` and its immediate subdirectories, and before M1 every MQTT
    definition fails its validation there.

## Amendment requests

- **M1: ADR-013, `packages/connector-sdk/src/definition.ts`: the definition keeps `mqtt`.**
  `ConnectorProviderDefinition.mqtt?: MqttSpec`, and `definitionSchema` gains
  `mqtt: s.optional(mqttSpecSchema)`, with `MqttSpec`, `mqttSpecSchema`, `MQTT_PRESETS`,
  `MAX_MQTT_TOPICS`, `MAX_POSITION_TABLE`, `MAX_MQTT_PAYLOAD_BYTES`,
  `MAX_MQTT_MESSAGES_PER_SECOND` and `DEFAULT_MQTT_FLUSH_MS` moved unchanged from
  `mqtt/contract.ts` (with `checkTopicFilter` from `mqtt/topics.ts`, which the schema's
  refine uses). The shape: `{ topics: 1–16 × { topic: filter ≤ 256, qos?: 0|1 } (no
duplicates; + a whole level, # whole and last, no control characters); port?: 1–65535;
tls?; username?: printable ≤ 128; credential?: { name }; clientId?: [A-Za-z0-9_-]{1,64};
preset?: 'rtl_433'|'owntracks'|'meshtastic'; itemsPath?; filter?: ≤ 16 conditions;
flushMs?: 0–5000; maxPayloadBytes?: 256 B–1 MiB; maxMessagesPerSecond?: 1–2000;
keepAliveSeconds?: 5–3600; positions?: ≤ 1024 × "<id>": [lat, lon] }`. The top-level refine
  gains `checkMqttDefinition`: `mqtt.credential` names a declared credential, and a
  definition with `mqtt` has no `endpoint`, `websocket` or `file`. There is deliberately no
  host field: the broker host is the operator's setting. No change to `definitionToManifest`
  is needed, because the connector sets `transport`, `allowedHosts`, `trustedHostSetting`
  and its settings itself (`mqttManifest`). Tests: an `mqtt` block survives `parseDefinition`,
  and the refusals in `mqtt.test.ts` ("the mqtt block is checked") move with it. Then:
  `contract.ts` re-exports from the SDK, `parseMqttDefinition` becomes `parseDefinition`, and
  the tripwire test "M1 tripwire: …" flips to assert the registry accepts the examples.
- **M2: ADR-013, `packages/connector-runtime/src/testing/suite.ts`: the suite's MQTT mode.**
  For a definition with an `mqtt` block, the suite builds the context with
  `createFixtureContext({ mqtt: new testing.FixtureMqtt() })` and runs the checks
  `mqtt/testing/suite.ts` runs. Each fixture body is one message
  `{ topic, payload, retained? }`, or an array of them, or a bare body delivered on the first
  topic with its wildcards filled in (`sampleTopic`). The checks: Successful parse, Empty
  response, Malformed response (ignored, still LIVE), Cancellation and Reconnect (OFFLINE
  after a close, then a second connection within 3 s), as in socket mode. The broker equivalents of the HTTP checks: Timeout is an
  unreachable broker (OFFLINE), Auth failure is a refused CONNACK (AUTH → AUTH_REQUIRED),
  and Oversized payload is the cap passed on (≤ 1 MiB) with the runtime's drops reported.
  New: Local endpoint (local transport, `trustedHostSetting`, loopback-only `allowedHosts`;
  connects to 127.0.0.1 with no setting and to the named host with one) and No transport
  (UNSUPPORTED). Missing fields, Attribution, Data policy and Rate policy are unchanged.
  The sidecar format is unchanged. Then: the examples move up to `connectors/examples/mqtt/`,
  where `connector:test --all` runs them; `mqtt/testing/suite.ts` and
  `loadSidecarFixtures` go, and `mqtt.test.ts` calls `runConnectorSuite`.
- **M2, optional, ADR-003 `testing.ts`:** `FixtureMqtt` could offer to call `onOpen`, and
  deliver queued messages, before `connect` resolves, which is what `mqtt-client.ts` does
  on a SUBACK. `mqtt.test.ts` covers that ordering today with its own `ProviderMqtt`
  ("the runtime's order"). And `FixtureContextOptions.mqtt` could take any `ProviderMqtt`, not only
  a `FixtureMqtt`; the test spreads its own broker into the context instead.
- **Slot files:** the registry's import line sits beside the other phase import lines,
  marked `// phase:mqtt` ("keep both", as for ogc, arcgis, stac and files).

The transport, as landed:

- **ADR-003:** **Landed** (2026-09-23 amendment). `context.mqtt?.connect(opts, events)` with
  `opts: { host, port?, tls?, username?, credential?: { key }, clientId?, subscriptions:
[{ topic, qos? }], maxPayloadBytes?, maxMessagesPerSecond?, keepAliveSeconds?,
connectTimeoutMs?, signal? }` and `events: { onMessage(topic, payload: Uint8Array,
{ retained, qos }), onOpen?, onClose?(reason), onError?(ProviderError) }` → `{ close(),
dropped }`. Present only on a `local-process` / `hardware` provider; the host must be
  loopback in `allowedHosts` or the trusted host (`trustedHostSetting`); the password is the
  credential named by `credential.key` (declare it in `manifest.credentials`), the username
  is plain. No client library: the runtime's own MQTT 3.1.1 subscriber. Health should say
  UNSUPPORTED plainly when `context.mqtt` is absent. Build against `testing.FixtureMqtt`
  (`createFixtureContext({ mqtt })`; `connections[n].simulateOpen`,
  `simulateMessage(topic, payload, { retained })`, `simulateClose`, `simulateError`;
  `refuse`, `secrets`). Delete the phase's shim on rebase.

## Independent review

A reviewer session that had not written the code checked the branch at `f82ebaa` against
this brief, PARALLEL-PHASES.md, the ADRs and the real client (`mqtt-client.ts`). It ran the
tests, typecheck, boundary check, phase-check and `connector:test --all`, and tried
mutations in a separate worktree. Findings and what was done, with a test for each that
fails on the old code (checked by reverting each fix):

1. A reconnect attempt that a changed broker address had overtaken could still fail,
   schedule a reconnect of its own and orphan the live connection; in `subscribe` it could
   close the session under the newer attempt. **Fixed:** an overtaken attempt resolves
   quietly, and a session closed mid-connect throws CANCELLED.
2. Every connection shared the session's abort signal, so the runtime's per-connection
   listener piled up across reconnects. **Fixed:** one `AbortController` per connection,
   aborted when it is superseded or the session closes.
3. `position.fixed` could place a moving device that had no fix, with nothing on the
   observation to say so. **Fixed:** the setting applies to stationary sources only, placed
   observations carry `configured-position`, and the Source Health message fits the source.
4. Meshtastic kept the previous fix's time for a new fix without one. **Fixed.**
5. Tyre-pressure sensors were classed `sensor`. **Fixed** (decision 10).
6. The brief ticked evidence that was not there yet, and said "six models". **Fixed:** the
   evidence is below and the count is five.
7. "Retained once" missed a value first seen live. **Fixed** (decision 4).
8. `mqtt.filter` could not see the topic on an array message. **Fixed:** the probe is
   `{ _items, _topic, _topicLevels }`, documented.
9. The `_topic[n]` rewrite was untested in position, motion and `mapping.filter`, and
   missed `$._topic[n]` / `["_topic"][n]`. **Fixed and tested.** The dead
   `delete merged['_time']` in the rtl_433 preset is gone.
10. A device id such as `constructor` read an inherited table key. **Fixed** (`Object.hasOwn`).
11. `2026-02-30` rolled over into March. **Fixed:** a date that does not exist is not a time.
12. Cancelling during the first connect reported OFFLINE. **Fixed:** CANCELLED, no error.
13. The suite's Reconnect check did not check for a reconnect, and Oversized payload did not
    check that the definition's cap is passed on. **Fixed** in `testing/suite.ts`. The
    fixture's `onOpen` ordering is the optional M2 item above.
14. The guide did not say that a self-signed broker certificate is refused. **Fixed** in the
    guide.

The reviewer also confirmed, among other things: only owned paths and slot lines changed;
the host comes only from `brokerHost` or 127.0.0.1; nothing is published (clean session, no
will); the password never reaches the provider; Meshtastic text never reaches an
observation; sidecar expectations are really checked; and a real-client run over loopback
delivers a retained message before `connect` resolves, which the provider handles.

## Evidence

(filled in at the end)
