# Phase `home-assistant` — Home Assistant

Status: open · Branch: `phase/home-assistant` · Target: 0.2.0 · Owner: (unassigned)

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

1. `packages/connector-runtime/src/connectors/home-assistant/{home-assistant,entities}.ts`,
   `index.ts`; slot lines.
2. Examples with sidecars and fixtures under `connectors/examples/home-assistant/`,
   `fixtures/connectors/home-assistant/`: a states snapshot with trackers, persons, zones
   and sensors; a `state_changed` event stream; the auth handshake.
3. `docs/connectors/home-assistant.md`: creating the token, the URL, what is read and
   what is never sent.
4. `home-assistant.test.ts`: suite (socket path) plus the REST snapshot; entity selection;
   auth failure (`auth_invalid`); reconnect resubscribes.
5. Changelog fragment; status and evidence.

## Definition of done

- [ ] `connector:test --all` green
- [ ] a live run against a real instance pasted (the operator's, on the LAN)
- [ ] a test proves no frame other than `auth`, `subscribe_events` and `ping` is ever sent
- [ ] `phase-check` passes; all common checks green

## Design notes

- The socket needs a `ws://` to loopback or the trusted host; the schema's `wss`-only rule
  is for public hosts. Check whether `websocket.url` validation applies the local policy
  when `trustedHostSetting` is set; if not, that is a small amendment request (ADR-013).
- `state_changed` events carry `new_state`; map that, keep `old_state` out of the payload.
- Persons without a tracker have no position; skip with a filter, not a rejection.

## Amendment requests

(fill in: local-host `ws://` for socket definitions with a trusted host, if needed)

## Evidence

(filled in at the end)
