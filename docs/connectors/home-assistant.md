# Home Assistant (`home-assistant`)

The `home-assistant` connector shows entities of your own Home Assistant on the map: its
zones, its weather entities and the environmental and energy sensors you choose, live. It
reads them through Home Assistant's own documented APIs with a long-lived access token and
**never controls anything**: no service is called, nothing is written, over either API.

Three example definitions live in `connectors/examples/home-assistant/`:

| Definition               | Object type       | What it shows                                                                                                                                     |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `home-assistant-zones`   | `place`           | every `zone.*`: home and the places you named, with their radius (who is in a zone, and when that changed, is not read)                           |
| `home-assistant-weather` | `weather-station` | every `weather.*`: condition, temperature, dew point, humidity, pressure, wind, visibility — in SI units                                          |
| `home-assistant-sensors` | `sensor`          | `sensor.*` measurements of an environmental or energy kind (temperature, humidity, pressure, particulates, CO2, light, wind, rain, power, energy) |

Copy one into your connectors folder, store the token, set the host, and switch it on. All
three are `review: "user-configured"` and `enabled: false`, and open no data policy.

## Never read: people and their devices

`person.*` and `device_tracker.*` entities are dropped the moment they arrive, from
`/api/states` and from the socket alike. They are never kept, mapped or emitted, whatever a
definition's filter or the Entities setting selects. They are phones, personal trackers and
named people, and following them is outside what WORLDVIEW does
([PRODUCT-BOUNDARIES.md](../PRODUCT-BOUNDARIES.md): no private-device tracking, no
following a named person). A definition whose filter names them validates with a warning
and shows nothing.

Zones are read for where they are, not for who is in them. A zone's state (how many people
are inside), its `persons` attribute (which people) and its update times (which move when
someone arrives or leaves) are dropped as the zone arrives. A zone therefore carries the time
it was read (flag `fetch-time`), and a `state_changed` event whose only change was who is in
the zone emits nothing.

## 1. Create the token

In Home Assistant, open your **profile** (your name, bottom left) → **Security** → **Long-lived
access tokens** → **Create token**. Name it after this computer ("WORLDVIEW on the desk
PC"). Home Assistant shows the token once; copy it.

Make the token for a user who can see the entities you want. It does not need to be an
administrator: nothing here needs more than reading states and subscribing to
`state_changed`, which Home Assistant allows every user.

In WORLDVIEW, store it under **Sources → Credentials** as `home-assistant-token` (the
`secretRef` the examples declare). The definition holds only that name; the host attaches the
token to each request and to the socket's first frame, and the connector never sees it
anywhere else. For `connector:test --live` the token comes from `ONEVIEW_SECRET_HOME_ASSISTANT_TOKEN`.

To revoke access, delete the token in the same place in Home Assistant.

## 2. The address

The instance is set in the source's settings, never in the definition:

| Setting | Default                     | Meaning                                                                                                                                                                                                    |
| ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`  | this computer (`127.0.0.1`) | The IP address or host name of your Home Assistant (`192.168.1.20`, `homeassistant.local`). This is the source's one trusted host (ADR-003 `trustedHostSetting`): only it, and loopback, may be contacted. |
| `port`  | `8123`                      | Home Assistant's HTTP port.                                                                                                                                                                                |
| `tls`   | off                         | On when Home Assistant answers `https://` at that host and port. Off, the token crosses your network in the clear, as it does for Home Assistant's own apps on plain HTTP.                                 |

So `http://192.168.1.20:8123` is `host` = `192.168.1.20`; `https://ha.example.org` is
`host` = `ha.example.org`, `port` = `443`, `tls` on. Nothing is discovered: an empty host
means this computer, never a scan of the network. A host that is not a DNS name or IPv4
address is refused and Source Health says so.

## 3. What is read

- **`GET /api/states`** — every entity's current state, with `Authorization: Bearer <token>`,
  up to 16 MiB. The first poll reads it, and so does every poll (once a minute) while the socket
  is not live.
- **The WebSocket API, `/api/websocket`**. On open the connector sends
  `{"type": "auth", "access_token": …}`. After `auth_ok` it sends
  `{"id": 1, "type": "subscribe_events", "event_type": "state_changed"}`, and every 30 s it
  sends `{"id": n, "type": "ping"}`. **Those three are the only frames ever sent**
  (`HA_ALLOWED_FRAMES`; a test fails if any other appears). Each `state_changed` event's
  `new_state` is mapped and emitted within half a second. `old_state` is never read into a
  record. A `new_state` of `null` (entity removed) takes the entity out of the next
  snapshot.
- While the socket is live, a poll answers from the states the socket keeps current, reads
  `/api/states` again after every (re)subscription so nothing missed while it was down
  stays wrong, and reads it anyway every ten minutes.

Health says which path is carrying the source ("live over the WebSocket API", or "reading
/api/states once a minute" and why the socket is not live).

### The socket on this build

This build's host opens WebSockets only as `wss://`. So with `tls` **on**, the socket works to
your host. With `tls` **off** (plain `http://` on your network), the host refuses `ws://`. The
source then runs on `/api/states` once a minute, says so in Source Health, and asks for the
socket again every 15 minutes. The phase brief records `ws://` to loopback or the trusted host
as an amendment request. When it lands, the same definition goes live over the socket with
nothing changed.

### Failures

| What happened                                                         | What you see                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No token stored                                                       | AUTH_REQUIRED, "credential home-assistant-token not configured"; nothing is sent. Storing the token re-polls at once                                                                                                                                  |
| Token refused by `/api/states` (`401`)                                | AUTH_REQUIRED; the host stops polling until the credential changes or the source restarts                                                                                                                                                             |
| Token refused by the socket (`auth_invalid`)                          | AUTH_REQUIRED with Home Assistant's message; the socket is not tried again (Home Assistant can ban an address after repeated failed logins), except once after `/api/states` has since accepted the token, and after a change of address or a restart |
| Host setting not a host name or IPv4 address                          | ERROR naming it; polls back off (up to 15 minutes) and a corrected setting is read on the next one                                                                                                                                                    |
| Home Assistant not answering                                          | OFFLINE; polls back off; the socket reconnects from 2 s up to a minute                                                                                                                                                                                |
| No answer to `auth` within 15 s, or silence for 75 s on a live socket | the socket is dropped and reconnected                                                                                                                                                                                                                 |
| `/api/states` not JSON, not an array, or no entry a state             | ERROR (MALFORMED)                                                                                                                                                                                                                                     |

A read of `/api/states` that was in flight when the address changed is thrown away and
the new address is read. Changes the socket reports while a read is in flight are applied
over its answer, so a resync never undoes a newer event.

## 4. Selecting entities

A definition selects by **domain** with its mapping filter (`{"path": "_domain", "equals":
"weather"}`) and by any attribute (the sensors example also requires `state_class:
measurement` and one of a list of `device_class` values, which keeps phone batteries and the
like out). The **Entities** setting narrows that further with entity-id patterns separated
by commas, semicolons or new lines, `*` the only wildcard: `sensor.outdoor_*, sensor.house_power`.
At most 64 patterns; a pattern that is not one is ignored and named in Source Health, and
if the setting holds no valid pattern at all nothing is shown (it never falls back to
everything). Matching is a plain scan with no regular expression, so any number of stars
costs the same.

## 5. Positions

An entity's position is, in order:

1. its own `latitude` / `longitude` attributes (numbers in range; `0, 0` is no position);
2. the first entry of the **Positions** setting whose pattern matches it:
   `sensor.garden_*=21.2972,-157.8171` (a fixed point) or `sensor.garden_*=zone.garden`
   (where that zone is). Entries are separated by semicolons or new lines, at most 64;
3. only if the definition says so, Home Assistant's home location (`zone.home`). The weather
   and sensor examples map `"position": {"latLon": {"path": "_position", "fallback": "_home"}}`;
   the zones example does not fall back.

An entity with none of these is rejected ("no position") and counted in Source Health.
Home Assistant's `/api/states` does not say which area an entity is in. Reading the area
registry would take a frame this connector does not send, so "per area" is a zone reference
in the Positions setting.

## 6. The record a mapping reads

The state object as Home Assistant sends it (`entity_id`, `state`, `attributes`,
`last_changed`, `last_updated`) plus derived fields under `_` names:

| Field                  | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_domain`, `_objectId` | the two halves of `entity_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `_position`            | `[lat, lon]` from the attributes or the Positions setting (above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `_positionSource`      | `attributes`, `table` or `zone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `_home`                | `[lat, lon]` of `zone.home`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `_numeric`             | the state as a number, when it is one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `_available`           | false when the state is `unavailable` or `unknown`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `_si`                  | readings in SI units. A sensor: `value` and `unit`, converted when Home Assistant's `unit_of_measurement` has an SI counterpart (°F → °C, and K → °C for a `temperature` device class only; mph, km/h, kn, ft/s → m/s; inHg, Pa, kPa, mmHg, psi, mbar → hPa; in → mm; mi, km, ft → m), otherwise kept as stated (%, W, kWh, µg/m³, ppm). A weather entity: `temperatureC`, `apparentTemperatureC`, `dewPointC`, `pressureHpa`, `windSpeedMps`, `windGustMps`, `visibilityM` by its `*_unit` attributes, `humidityPct`, `windDirDeg`. |

Conversions go through the mapping's transform registry (`fahrenheitToCelsius`,
`inchesHgToHpa`, `scale:<n>` …), so a definition can also convert a raw attribute itself. A
reading whose unit Home Assistant does not state is left out of `_si`, never assumed.

## 7. Limits and what is not here

- No service calls, ever; no history API; no camera streams (the camera gateway's job); no
  logbook, no templates, no registries.
- At most 50,000 entities are kept (the rest are counted in Source Health); a socket message
  over 1 MiB is dropped by the host.
- `connector:test --live` passes no settings to a source, so from the command line it can
  reach only an instance on this computer (`127.0.0.1:8123`). For an instance on your
  network, run the live check in the app (enable the source, set `host`, read Source Health),
  or run the check from the machine Home Assistant runs on. A `--setting key=value` flag is in
  the phase brief's amendment requests.
