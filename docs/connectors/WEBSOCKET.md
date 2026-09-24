# WebSocket JSON connector (`websocket-json`)

Subscribes to a `wss://` endpoint that sends JSON messages, optionally after a subscribe
frame, and maps the records in each message. The socket is opened by the provider host
(`ProviderSockets`), which enforces the host allow-list and resolves the credential; the
definition never holds the secret.

```json
{
  "schema": "oneview.connector.v1",
  "id": "sample-vehicle-feed",
  "name": "Sample vehicle positions",
  "connector": "websocket-json",
  "objectType": "transit-vehicle",
  "websocket": {
    "url": "wss://feeds.example.org/vehicles",
    "subscribe": { "action": "subscribe", "channel": "positions", "token": "{secret}" },
    "heartbeat": { "action": "ping" },
    "heartbeatSeconds": 30,
    "credential": { "name": "token" },
    "itemsPath": "vehicles",
    "filter": [{ "path": "type", "equals": "positions" }],
    "flushMs": 500
  },
  "credentials": {
    "token": { "secretRef": "sample-vehicle-feed.token", "label": "Sample feed token", "kind": "token" }
  },
  "mapping": {
    "externalId": "id",
    "observedAt": { "path": "ts", "transform": "unixSeconds" },
    "position": { "lat": "lat", "lon": "lon" },
    "motion": { "speedMps": { "path": "speed_knots", "transform": "knotsToMps" }, "headingDegrees": "heading" }
  },
  "attribution": { "text": "Sample feed" }
}
```

## `websocket`

| Key               | Meaning                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`             | `wss://` to a public host (same policy as endpoints).                                                                                                                                            |
| `subscribe`       | A JSON value sent once the socket opens; `{secret}` inside any string value is replaced by the credential's secret.                                                                              |
| `heartbeat`       | A JSON value sent every `heartbeatSeconds` (default: none).                                                                                                                                      |
| `credential`      | `{ "name": "<key of credentials>" }` — resolved by the host and handed to the connector only for the subscribe frame.                                                                            |
| `itemsPath`       | Path in each message to the record or array of records; default: the message itself.                                                                                                             |
| `filter`          | Conditions a message must satisfy to be read at all (heartbeats, acks and status messages are dropped this way).                                                                                 |
| `flushMs`         | Records are coalesced for this long before a batch is emitted (default 500 ms; 0 emits per message). Snapshot semantics still apply per object: the newest record for an id wins within a batch. |
| `maxMessageBytes` | Larger messages are dropped and counted (default 1 MiB).                                                                                                                                         |

## Behaviour

- Messages that are not JSON, or have nothing at `itemsPath`, are counted and ignored; the
  socket stays open. A record the mapping rejects is counted, as for a poll.
- The connection is re-established after a close or error with exponential back-off (2 s →
  60 s); health is DEGRADED while reconnecting, ERROR after repeated failures, LIVE again
  on the first good message.
- AUTH_REQUIRED when the credential is not configured; nothing is opened until it is.
- Binary frames and per-message compression are not handled in Wave 1 (see the roadmap).

## Testing

The shared suite drives the connector through a fixture socket: the sidecar's `normal` is a
list of messages, `empty` a message with no records, `malformed` messages that must be
ignored, and the suite checks subscribe (with the secret), reconnect, attribution and
policy along with the common checks — see [TESTING.md](TESTING.md).
