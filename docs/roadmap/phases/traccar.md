# Phase `traccar` — Traccar

Status: open · Branch: `phase/traccar` · Target: 0.2.0 · Owner: (unassigned)

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

1. `packages/connector-runtime/src/connectors/traccar/{traccar,session}.ts`, `index.ts`;
   slot lines.
2. Examples with sidecars and fixtures under `connectors/examples/traccar/`,
   `fixtures/connectors/traccar/`: devices, positions, socket messages, an event.
3. `docs/connectors/traccar.md`.
4. `traccar.test.ts`: suite; snapshot + socket merge; knots conversion; auth failure.
5. Changelog fragment; status and evidence.

## Definition of done

- [ ] `connector:test --all` green
- [ ] a live run against a Traccar demo server or the operator's pasted
- [ ] `phase-check` passes; all common checks green

## Design notes

- Positions arrive per device with `deviceId`; join with the devices snapshot for the name
  (refresh the snapshot every few minutes; a position for an unknown device is kept with the
  id as its label).
- `fixTime` is the observation time, `serverTime` the receipt; use `fixTime`.
- Object type: `transit-vehicle` for vehicles, `sensor`/`place` otherwise — the definition
  chooses; default `transit-vehicle`.

## Amendment requests

- **ADR-003 / ADR-013 (socket credential in the URL query): landed** (2026-09-23
  amendment, integrator item #10). `websocket.credential: { name, as: "query", param? }` in
  a definition — or `ProviderSockets.open(url, events, { credential: { key, as: 'query',
param } })` from a provider — has the host append `param=<secret>` (`token` by default)
  to the URL it dials; `onOpen` gets no secret and no log or health line carries the URL.
  `testing.FixtureSockets` records the dialed URL (`opened[n].url`). The REST path
  (`/api/positions`) remains the fallback for a server whose socket refuses the token.

## Evidence

(filled in at the end)
