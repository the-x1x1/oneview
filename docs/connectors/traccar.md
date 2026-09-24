# Traccar connector (`traccar`)

[Traccar](https://www.traccar.org/) is the open-source GPS tracking server many fleets and
hobbyists run for their own trackers. The `traccar` connector makes one Traccar server a
source: its devices become objects at their latest positions, with speed, course,
altitude, battery, ignition, motion, protocol — and, when the socket is used, the event
Traccar raised with a position.

It reads the server two ways:

- **REST** — `GET /api/devices` (names, categories, status; read again every five minutes)
  and `GET /api/positions` (the latest position of every device the token can see), every
  `endpoint.intervalSeconds`. This works on any Traccar server that accepts the token.
- **The socket** — with a `websocket`, `/api/socket` pushes positions, device changes and
  events as they happen. The REST poll keeps running underneath at its own cadence, so the
  snapshot and the device names stay current, and positions keep arriving if the socket
  goes away.

Only what the operator's own server already shows them is read. Nothing is sent to a
device, no geofence is changed, and no history or report is exported.

```json
{
  "schema": "oneview.connector.v1",
  "id": "traccar-demo-live",
  "name": "Traccar devices, live (demo.traccar.org)",
  "connector": "traccar",
  "objectType": "transit-vehicle",
  "endpoint": {
    "url": "https://demo.traccar.org",
    "intervalSeconds": 300,
    "credential": { "name": "token", "as": "bearer" }
  },
  "websocket": {
    "url": "wss://demo.traccar.org/api/socket",
    "credential": { "name": "token", "as": "query", "param": "token" }
  },
  "credentials": {
    "token": { "secretRef": "traccar-demo.token", "label": "Traccar demo server token", "kind": "token" }
  },
  "mapping": {
    "externalId": "deviceId",
    "observedAt": { "path": "fixTime", "transform": "isoTimestamp" },
    "position": { "lat": "latitude", "lon": "longitude", "alt": "altitude" },
    "labels": { "name": "deviceName", "category": "device.category" },
    "properties": {
      "status": "device.status",
      "batteryLevel": { "path": "attributes.batteryLevel", "transform": "number" },
      "ignition": { "path": "attributes.ignition", "transform": "boolean" },
      "event": "event.type"
    },
    "motion": {
      "speedMps": { "path": "speed", "transform": "knotsToMps" },
      "headingDegrees": { "path": "course", "transform": "headingDegrees" }
    }
  },
  "attribution": { "text": "Traccar demo server (demo.traccar.org), your own account's devices" },
  "review": "user-configured",
  "enabled": false
}
```

The full examples are in `connectors/examples/traccar/`: `traccar-demo-live.json` (REST
and the socket), `traccar-demo-rest.json` (REST alone) and `traccar-local.json` (a server
on this computer or your network).

## The server

| Definition               | Where it reads                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint.url` set       | A public server: `https://host[/prefix]`, the address you open Traccar's web interface at (a trailing `/api` is the same thing). Not an API path, no query. Same URL policy as every definition: https, a public host. |
| no `endpoint`            | A server on **this computer** (`http://127.0.0.1:8082`), or on the one host you name in the source's `host` setting, at its `port` setting (default 8082) — ADR-003's local policy: plain http, nothing discovered.    |
| `websocket.url` (public) | Must be the same server's socket: `wss://host[/prefix]/api/socket`, no query.                                                                                                                                          |

A local server is read by REST only: the host opens `wss://` sockets to public hosts alone
(ADR-003). Its positions are polled every 30 seconds, and a definition for one may not
have a `websocket`.

## The token

Traccar answers nothing without authentication. Create a token in Traccar (Settings →
Preferences → Token, on Traccar 5.x and later) and store it in Sources → Credentials under
the definition's `secretRef`; the definition never holds it.

- REST: `endpoint.credential` with `as: "bearer"` — the host sends the token as a bearer
  token in the `Authorization` header. (`as: "header"` with `param` names another header,
  for a server behind a proxy that wants one.) A local definition has no endpoint: it declares the credential as
  `credentials.token`, sent the same way.
- The socket: `websocket.credential` with `as: "query"` — the host appends `?token=<token>`
  to the URL it dials (ADR-003/ADR-013 amendment for this connector). The provider never
  sees the token, and no log or Source Health line carries that URL.

Whether a given Traccar version accepts `?token=` on `/api/socket` is not settled:
Traccar's API page says the session cookie is the only way to authenticate the socket,
while its developer has said on the forum that a `token` query parameter works. If your
server refuses it, the source reports the socket unavailable (DEGRADED, with the reason)
and the REST poll carries on — or use a definition without a `websocket`, like
`traccar-demo-rest.json`, and a shorter `intervalSeconds`.

A 401 or 403 on a REST call is AUTH_REQUIRED. Without the credential, the socket is not
opened at all. A socket that refuses the token is not reported as AUTH_REQUIRED: the host
sees only the connection close, so the source shows DEGRADED (the poll works) or OFFLINE,
and the socket is dialled again with back-off, up to once a minute.

## What a record holds

Each position becomes one record for the definition's own `mapping`, so the definition
decides the object type (`transit-vehicle` in the examples; `sensor` or `place` suit
fixed assets), the labels and the properties. The record is Traccar's position as the
server sent it —

`id`, `deviceId`, `protocol`, `serverTime`, `deviceTime`, `fixTime`, `outdated`, `valid`,
`latitude`, `longitude`, `altitude` (metres), `speed` (**knots**), `course` (degrees),
`accuracy`, `address`, `attributes` (`batteryLevel`, `ignition`, `motion`, `sat`, …)

— with three more fields beside it:

| Field        | What it is                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceName` | The device's name; its id as text for a device the last device list did not name (one added since), until the next list names it.                                           |
| `device`     | `{ id, name, category, status, model, disabled, lastUpdate }` when the device is known. Never `uniqueId`, `phone` or `contact`; `attributes.driverUniqueId` is dropped too. |
| `event`      | The device's latest event, on the position it belongs to: `{ type, eventTime, positionId, geofenceId, alarm }` (`alarm` from the event's attributes, `sos` and the like).   |

Map `externalId` from `deviceId` (one object per device) and `observedAt` from `fixTime`
— the time of the fix, not `serverTime`, the time the server received it. Speed is in
knots: use the `knotsToMps` transform.

## Events

Events (`geofenceEnter`, `geofenceExit`, `alarm`, `ignitionOn`, `deviceOverspeed`, …)
arrive only over the socket — `/api/positions` carries none — so a REST-only or local
source has no events, and its examples map none. They are not separate objects in this
release: each is the payload of its device's latest observation. When the socket delivers
an event, or a change to a device, without a new position, the device's last position is
sent again with the new event or name (same `fixTime`, so the object does not move or look
fresher than it is; the state engine records it as one more point at that time). An event
rides on the position it names, or on one no newer than the event, so an alarm from an hour
ago is not attached to every later fix. Map the event fields with `"default": null`, as
`traccar-demo-live.json` does: the object's properties are merged from one observation to
the next, so a field left out keeps the old alarm on the map, while `null` clears it. An
older event never replaces a newer one, and an event whose position has already been
overtaken by a newer fix when it arrives is kept for the device but not shown on that
older fix.

## Devices that are people

Traccar lets a device's category be `person`. Those devices are left out altogether:
their positions are counted and never mapped, and Source Health says so. This fails
closed: no position is shown until one whole device list (`/api/devices`) has been read,
because until then a device's category is unknown — a poll whose first device list fails
fails with that error, and socket positions of devices nothing has described yet are held
back until the poll has read the list. After that, a device the list does not name (one
added since) is shown labelled by its id until the next list names it, and a later list
that fails leaves the last one in force. WORLDVIEW is not
a people-tracking system ([PRODUCT-BOUNDARIES.md](../PRODUCT-BOUNDARIES.md)): point this
connector at equipment you own or operate — vehicles, boats, machinery, assets — not at
trackers carried by people. The category is the only thing the connector can see; the
rest is the operator's responsibility.

## Health

- LIVE after a good poll, or while the socket is connected (until the first device list
  is read, the message says positions of devices not yet described are held).
- DEGRADED when the socket dropped (or was refused) but the poll works: "live socket
  unavailable (…); positions from the poll every N s". The socket is reopened with
  back-off from 2 s to a minute.
- OFFLINE / ERROR / AUTH_REQUIRED / RATE_LIMITED as the host classifies failures.
- The message also says when a later device list could not be read (the last one stays in
  force; the list is tried again a minute later), when positions of `person` devices were
  left out, and how many positions the mapping rejected.

Once a device list has been read, a device-list failure does not stop the positions unless
it is one the positions would share (auth, timeout, offline, rate limit). A positions answer that is not a list, or in
which no position is usable, is MALFORMED and never served from the cache.

## Limits

- 8 MiB per REST answer (`endpoint.maxBytes`), 1 MiB per socket message
  (`websocket.maxMessageBytes`), 10,000 devices remembered.
- Every poll is two requests at most; the request limit and the poll budget are sized for
  that (ADR-013's poll burst amendment).
- `pagination`, `response`, `boundsQuery`, `websocket.subscribe` and a POST endpoint are
  refused or ignored: a Traccar server answers for all its devices, in its own shape.
- `endpoint.headers` may not carry `Authorization`, `Cookie` or `Proxy-Authorization`: a
  token or a session is a credential reference, never text in a definition. The socket's
  `param` is `token` or left out.
- Validation warns when `observedAt` is not `fixTime`, or when `speed` is mapped without
  `knotsToMps`.

## Testing

`connector:test` runs the shared suite on each example: the REST ones against
`fixtures/connectors/traccar/suite-combined.json` — the suite serves one body for every
request, so each entry there is a device and its position in one object, answering both
`/api/devices` and `/api/positions`; no Traccar server sends that — and the socket one
against a devices message, a positions message, an events message and a keep-alive. `traccar.test.ts` answers `/api/devices` and
`/api/positions` separately and covers the join, the knots conversion, the device-list
refresh and failure, auth failures, the socket's token in the dialed URL, snapshot and
socket merged, events re-sent on the last position and not on later fixes, `person`
devices before and after a device list, back-off (one drop per failure, retry of a socket
that could not open at start) and the local server's address and settings change. The fixtures are invented in Traccar's published shape, not
recorded.

`connector:test --live` on `traccar-demo-live.json` or `traccar-demo-rest.json` needs an
account and a token on a Traccar demo server, in `ONEVIEW_SECRET_TRACCAR_DEMO_TOKEN`.
