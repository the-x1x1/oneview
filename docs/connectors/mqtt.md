# MQTT: the `mqtt` connector and its presets

A broker on your own network — Mosquitto, EMQX, the one inside Home Assistant — is a source.
The `mqtt` connector subscribes to topics on it and maps every JSON message into objects on
the map: weather stations and sensors your `rtl_433` receiver hears, your own phones and
tablets running OwnTracks, the nodes of your Meshtastic mesh, GPS trackers on your
equipment, or anything else that publishes JSON with an id and a position.

> **Status (phase `mqtt`).** The connector, its presets and its tests are complete, and the
> transport it uses (the runtime's own MQTT 3.1.1 client, ADR-003) is in the build. But one
> frozen contract does not yet carry an MQTT definition, so this build refuses every one with
> a message that says why. The phase's brief ([mqtt.md](../roadmap/phases/mqtt.md)) requests
> two amendments: **M1** the definition keeps its `mqtt` block (ADR-013), and **M2** the
> shared suite drives an MQTT definition through `testing.FixtureMqtt`. Until they land, the
> examples live in `connectors/examples/mqtt/awaiting-amendments/` and run the suite's MQTT
> mode from `mqtt.test.ts`.

## The broker

The broker is on this computer, or on the one host you name. Nothing else is ever contacted.

- **On this computer:** leave the source's **Broker address** setting (`brokerHost`) empty.
  The connector connects to `127.0.0.1` — by address, not `localhost`, which Windows resolves
  to `::1` first, where a broker may not be listening.
- **On another computer on your network:** type its address or host name in **Broker
  address** (`192.168.1.20`, `pi.home.example`). That setting is the source's trusted host
  (ADR-003): the runtime allows exactly that host, no subdomains, no wildcards, and only
  while the setting names it. Changing it reconnects at once.

A definition cannot name a broker host at all: the local-endpoint policy is the operator's,
set in the app, never something a definition file can open. A host the runtime refuses shows
in Source Health with the setting to name it in.

```json
"mqtt": {
  "topics": [{ "topic": "rtl_433/+/events" }],
  "port": 1883,
  "tls": false
}
```

| Field                  | Default                  | What it does                                                                       |
| ---------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `topics`               | (required)               | 1–16 topic filters, each with `qos` 0 (default) or 1. Never 2.                     |
| `port`                 | 1883, or 8883 with `tls` | The broker's port.                                                                 |
| `tls`                  | false                    | TLS to the broker (the server's certificate is checked against the host name).     |
| `username`             | none                     | The MQTT username. Not a secret.                                                   |
| `credential`           | none                     | `{ "name": "<key of credentials>" }`: the stored secret is the MQTT password.      |
| `clientId`             | `worldview-<random>`     | Letters, digits, `_` and `-`.                                                      |
| `preset`               | none                     | `rtl_433`, `owntracks` or `meshtastic` (below).                                    |
| `itemsPath`            | the message              | Path in each message to its record(s).                                             |
| `filter`               | none                     | Conditions on the message (as `mapping.filter`); a message failing one is skipped. |
| `flushMs`              | 500                      | Observations are coalesced by id for this long; 0 emits every message.             |
| `maxPayloadBytes`      | 256 KiB (runtime)        | 256 B – 1 MiB. A larger payload is dropped by the runtime and counted.             |
| `maxMessagesPerSecond` | 500 (runtime)            | 1–2000. Messages past it are dropped and counted.                                  |
| `keepAliveSeconds`     | 60 (runtime)             | 5–3600.                                                                            |
| `positions`            | none                     | Up to 1024 `"<external id>": [lat, lon]` for devices that send no position.        |

A definition with `mqtt` has no `endpoint`, `websocket` or `file`, and no `boundsQuery`: a
broker sends what it sends, not a view.

## Credentials

The username is plain text in the definition. The password is never in a file: declare a
credential and name it, and store the secret under its `secretRef` (Sources → Credentials).

```json
"mqtt": { "topics": [{ "topic": "owntracks/+/+", "qos": 1 }], "username": "worldview", "credential": { "name": "broker" } },
"credentials": { "broker": { "secretRef": "owntracks-devices.broker", "label": "Broker password", "kind": "basic" } }
```

The runtime resolves the secret when it connects and sends it in CONNECT; the provider only
knows the key. Nothing writes it to a log, to Source Health or to diagnostics. A credential
that is not stored yet is `AUTH_REQUIRED` and the broker is not contacted; a broker that
refuses the login is `AUTH_REQUIRED` too.

## Topics

A topic filter has levels separated by `/`; `+` stands for exactly one level and `#`, only
as the last level, for any number of levels including none (`a/#` matches `a`). Filters
starting with a wildcard never match the broker's own `$SYS/…` topics. The connector checks
every message's topic against the filters again, so a message on a topic it did not ask for
is counted in Source Health and never mapped.

Every record carries the topic to the mapping:

- `_topic` — the whole topic name, `trackers/van-1/position`;
- `_topic[n]` — its n-th level from 0 (`_topic[1]` is `van-1`), `_topic[-1]` the last.

```json
"mapping": { "externalId": "_topic[1]", "labels": { "name": "_topic[1]" } }
```

## Payloads

- A JSON object or array is records, as a WebSocket message is: `mqtt.itemsPath` finds them
  and `mqtt.filter` keeps or skips the whole message.
- Anything else — `21.5`, `ON`, plain text — is one record `{ "raw": "<payload>", "topic":
"<topic>" }` (under a preset it is skipped as unreadable, since a preset expects JSON).
- Bytes that are not UTF-8 are unreadable and counted.
- A message with more than 1000 records keeps the first 1000.

**Retained messages are taken once.** The broker re-sends a topic's retained message on
every reconnect; the connector maps it the first time and skips the same payload on the same
topic after that. A retained message's observations are marked as the broker's stored copy
(`cached`), and are dated by the message's own time, never the time it was re-sent.

## Positions

A record's position comes from, in order:

1. **The payload** — the mapping's `position`, as for every connector.
2. **`mqtt.positions`** — a table in the definition from the external id the mapping gives a
   device to `[lat, lon]`, for stationary sensors: `"Fineoffset-WH24:140": [21.3069, -157.8583]`.
3. **The `position.fixed` setting** — one `lat, lon` the operator types in the app, used for
   every other device of the source (one station, one receiver on the roof).

A device with none of the three is not placed on the map, and Source Health says so and names
it: `1 device(s) send no position — set position.fixed or add them to mqtt.positions:
LaCrosse-TX141THBv2:0:150`. Nothing is dropped silently.

## Presets

A preset is a named reader for a message format common on a home broker. It adds fields
starting with `_` to each record and leaves the source's own fields as they are. The set is
closed, like the mapping's transforms: a definition picks one, it cannot add one.

### `rtl_433`

For `rtl_433 -F mqtt://<broker>` (or `-F json` piped through a bridge): the `…/events` topic,
one JSON object per decoded transmission.

- `_device` — `model:channel:id` with the parts the device sends (`Acurite-5n1:A:1234`,
  `Fineoffset-WH24:140`). This is what `mqtt.positions` is keyed by.
- `_class` — `weather-station` when the device reports wind or rain, `sensor` when it reports
  temperature, humidity, pressure, moisture or light, `other` otherwise (door contacts,
  remotes, tyre sensors). Filter on it: `"filter": [{ "path": "_class", "equals": "sensor" }]`.
- One unit per reading, whatever the device sent: `_temperature_C` (from `temperature_F`
  too), `_pressure_hPa` (from kPa or inHg), `_wind_avg_m_s` and `_wind_max_m_s` (from km/h or
  mi/h), `_rain_mm` (from inches), `_rain_rate_mm_h`.
- Readings are merged per device: an Acurite 5-in-1 sends temperature in one message type and
  rain in the other, and each record is the device's latest value of every field it has sent.
- `_time` — only when the time is unambiguous: Unix seconds (`-M time:unix`), or a time with
  `Z` or an offset (`-M time:iso:utc:tz`). rtl_433's default `2026-09-24 07:12:01` is the
  receiver's local time with no zone; the connector does not guess the zone, and such a
  record is dated on arrival (flagged `fetch-time`). Run rtl_433 with `-M time:unix` or
  `-M time:iso:tz` to keep the device's time.

**Limitation:** rtl_433's per-field topics (`…/devices/<model>/<id>/temperature_C`, one
number each) are not read; subscribe to `…/events`.

### `owntracks`

For your own phones and tablets running OwnTracks in MQTT mode against your own broker, on
`owntracks/<user>/<device>`. Only `_type: "location"` messages are read; `_device` is
`<user>/<device>`, `_time` is `tst`, `_speed_m_s` is `vel` (km/h) in m/s. Transitions,
waypoints, cards and last-will messages are skipped, and so is an encrypted payload
(OwnTracks' own encryption), which the connector cannot read.

This preset is for devices you own and have set up to report to your broker. WORLDVIEW does not
track other people's phones (docs/PRODUCT-BOUNDARIES.md); the operator allowed this preset for
their own devices as a recorded exception in the phase brief.

### `meshtastic`

For a Meshtastic gateway with MQTT and **JSON output** enabled, on
`msh/<region>/2/json/<channel>/<gateway>`. `position` (`latitude_i`/`longitude_i` in 1e-7
degrees), `nodeinfo` (long and short name, hardware) and `telemetry` (battery, voltage,
channel use, environment readings) packets are merged per node, so every record is the node's
latest state and a telemetry packet appears where the node last reported itself. A position
of 0/0 (no fix, or position sharing off) is not a position. `_device` is the node id as
Meshtastic writes it (`!7efeee00`); `_name`, `_shortName`, `_lat`, `_lon`, `_alt`, `_battery`,
`_voltage`, `_temperature_C`, `_humidity`, `_pressure_hPa`, `_channel_utilization`,
`_air_util_tx`, `_type`.

**Text messages are never read**, nor any other packet type: what people send each other on
the mesh does not reach a record, an observation or a log.

### No preset: a generic tracker

JSON with an id and a position maps directly. The example `gps-trackers.json` reads trackers
on your vehicles or boats that publish to `trackers/<id>/position`:

```json
"mqtt": { "topics": [{ "topic": "trackers/+/position" }] },
"mapping": {
  "externalId": "_topic[1]",
  "observedAt": { "path": "time", "transform": "isoTimestamp" },
  "position": { "lat": "lat", "lon": "lon" },
  "motion": { "speedMps": { "path": "speed_kmh", "transform": "kmhToMps" }, "headingDegrees": "course" }
}
```

## Health

| Status          | When                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `LIVE`          | Connected, every subscription acknowledged.                                                          |
| `OFFLINE`       | The broker cannot be reached or dropped the connection; reconnecting (2 s up to 1 min).              |
| `AUTH_REQUIRED` | The password is not stored, or the broker refused the login or a subscription.                       |
| `ERROR`         | The host is not loopback or the named broker, or the build has no MQTT transport (`UNSUPPORTED: …`). |

While `LIVE`, the message names what needs the operator: devices without a position,
messages dropped by the size or rate cap, records the mapping rejected, unreadable messages
and messages on topics not subscribed to.

## What is never done

- Nothing is published: the runtime's client has no PUBLISH of its own, and the connector
  never asks for one. No retained message, will or subscription is left on your broker.
- No discovery: no broker is looked for, no other host or port tried.
- No password in a definition, a log or Source Health.
- No Meshtastic text message is read.
- No data policy is opened: every MQTT definition is `user-configured` and fails closed
  (commercial use unknown, no redistribution, no offline packs, no export, seven-day retention).

## Examples

In `connectors/examples/mqtt/awaiting-amendments/` (they move up one level when M1 and M2
land), each with a `.test.json` sidecar and invented fixtures in `fixtures/connectors/mqtt/`:

| File                            | Preset       | Object type       |
| ------------------------------- | ------------ | ----------------- |
| `rtl_433-weather-stations.json` | `rtl_433`    | `weather-station` |
| `rtl_433-sensors.json`          | `rtl_433`    | `sensor`          |
| `owntracks-devices.json`        | `owntracks`  | `sensor`          |
| `meshtastic-nodes.json`         | `meshtastic` | `sensor`          |
| `gps-trackers.json`             | none         | `transit-vehicle` |

All are `enabled: false`. To run one, copy it into your connectors folder, point
`mqtt.topics` at your broker's topics, and name the broker in the source's settings if it is
not on this computer.
