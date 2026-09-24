# Phase `mqtt` — MQTT connector and the rtl_433 preset

Status: open · Branch: `phase/mqtt` · Target: 0.2.0 · Owner: (unassigned)

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

1. Amendment request written first (below) and built against a fixture broker interface
   (`ProviderMqtt` shim in the phase's directory, matching the requested contract exactly)
   so the suite and unit tests pass before the amendment lands.
2. `packages/connector-runtime/src/connectors/mqtt/{mqtt,topics,presets}.ts`, `index.ts`;
   slot lines.
3. Examples with sidecars and fixtures under `connectors/examples/mqtt/`,
   `fixtures/connectors/mqtt/`: rtl_433 (several models), OwnTracks, Meshtastic, generic.
4. `docs/connectors/mqtt.md`: broker settings, TLS, credentials, topics, position options,
   the presets, what is never published.
5. `mqtt.test.ts`: suite via the fixture broker; topic matching; retained handling; fixed
   and table positions; reconnect.
6. Changelog fragment; status and evidence.

## Definition of done

- [ ] `connector:test --all` green using the shim
- [ ] a real-broker run pasted once the amendment lands (Mosquitto on the operator's machine)
- [ ] `phase-check` passes; all common checks green

## Design notes

- rtl_433 topic layouts vary (`rtl_433/<host>/devices/<model>/<id>/<field>` per-field vs
  `rtl_433/<host>/events` JSON); support the events JSON first, per-field topics as a
  documented limitation.
- Device identity: `model` + `id` (+ `channel`) → externalId; without a position the sensor
  needs `position.fixed` — say so in Source Health's message rather than dropping silently.
- Never write the broker password into a log; the credential store holds it.

## Amendment requests

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

## Evidence

(filled in at the end)
