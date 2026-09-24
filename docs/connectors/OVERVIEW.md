# Connectors

A connector runs a **definition**: one JSON document that says where a source is, how its
records are shaped and how each record becomes an object in the world. The code that
fetches, pages, maps, admits and reports health is written once per connector
(`packages/connector-runtime`) and shared by every definition that names it. A connector's
provider is an ordinary provider: the provider host, the HTTP allow-list, the cache, the
rate limit, credential scoping, admission and Source Health all apply exactly as they do to
hand-written code ([ADR-013](../adr/ADR-013-connector-architecture.md)).

```
definition (JSON)  ──validate──►  connector  ──createProvider──►  WorldProvider  ──►  provider host  ──►  world state
   endpoint / websocket             rest-json                        poll / subscribe        admission
   response, pagination             geojson                          map records             health
   mapping, freshness               csv                              health message          Source Health
   attribution, policy              websocket-json
```

## Which connector

| Source                                                    | Connector                | Guide                                                                      |
| --------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| HTTPS endpoint answering JSON (or CSV, or text)           | `rest-json`              | [REST-JSON.md](REST-JSON.md)                                               |
| GeoJSON FeatureCollection                                 | `geojson`                | [GEOJSON-CSV.md](GEOJSON-CSV.md)                                           |
| CSV file or export                                        | `csv`                    | [GEOJSON-CSV.md](GEOJSON-CSV.md)                                           |
| WebSocket sending JSON messages                           | `websocket-json`         | [WEBSOCKET.md](WEBSOCKET.md)                                               |
| WFS / OGC API Features / WMS / WMTS                       | phase `ogc` (planned)    | [../roadmap/phases/ogc.md](../roadmap/phases/ogc.md)                       |
| ArcGIS FeatureServer / MapServer                          | phase `arcgis` (planned) | [../roadmap/phases/arcgis.md](../roadmap/phases/arcgis.md)                 |
| STAC catalogues                                           | phase `stac` (planned)   | [../roadmap/phases/stac.md](../roadmap/phases/stac.md)                     |
| Local files (GeoJSON, CSV, GPX, KML; anything GDAL reads) | phase `files` (planned)  | [../roadmap/phases/files.md](../roadmap/phases/files.md)                   |
| MQTT broker, rtl_433                                      | phase `mqtt` (planned)   | [../roadmap/phases/mqtt.md](../roadmap/phases/mqtt.md)                     |
| Home Assistant                                            | phase `home-assistant`   | [../roadmap/phases/home-assistant.md](../roadmap/phases/home-assistant.md) |
| Traccar                                                   | phase `traccar`          | [../roadmap/phases/traccar.md](../roadmap/phases/traccar.md)               |
| Node-RED or anything that can POST                        | phase `ingest`           | [../roadmap/phases/ingest.md](../roadmap/phases/ingest.md)                 |

A source with its own protocol or device (an SDR, a camera gateway, a serial NMEA feed) is
still a provider: see [Building a provider](../providers/BUILDING-A-PROVIDER.md).

## A definition

```json
{
  "schema": "oneview.connector.v1",
  "id": "usgs-earthquakes-connector",
  "name": "USGS earthquakes (past day)",
  "connector": "geojson",
  "objectType": "earthquake",
  "categories": ["environment"],
  "endpoint": {
    "url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
    "intervalSeconds": 300
  },
  "mapping": {
    "externalId": "id",
    "observedAt": { "path": "properties.time", "transform": "unixMillis" },
    "position": { "geometry": "geometry", "altitude": false },
    "labels": { "name": "properties.place" },
    "properties": {
      "magnitude": { "path": "properties.mag", "transform": "number" },
      "depthKm": { "path": "geometry.coordinates[2]", "transform": "number" }
    }
  },
  "freshness": { "liveSeconds": 900, "recentSeconds": 3600, "expireSeconds": 86400 },
  "attribution": { "text": "U.S. Geological Survey Earthquake Hazards Program (public domain)" },
  "termsUrl": "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
  "review": "bundled",
  "enabled": false
}
```

| Field           | Meaning                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`        | Always `oneview.connector.v1`.                                                                                                                                           |
| `id`            | The provider id (lowercase, digits, `-`, `.`); unique across bespoke providers and definitions.                                                                          |
| `connector`     | Which connector runs it (`rest-json`, `geojson`, `csv`, `websocket-json`, …).                                                                                            |
| `objectType`    | One of the world model's object types (`aircraft`, `vessel`, `earthquake`, `sensor`, `place`, `imagery-scene`, …). Presentation hides unknown types, so this is checked. |
| `categories`    | Lens categories the source belongs to.                                                                                                                                   |
| `endpoint`      | URL (https), method, headers, query, body, credential, `intervalSeconds`, `timeoutSeconds`, `maxBytes`. Polling connectors.                                              |
| `websocket`     | URL (wss), subscribe and heartbeat frames, credential, `itemsPath`, `filter`, `flushMs`. Subscription connectors.                                                        |
| `pagination`    | `none`, `page-number`, `offset-limit`, `cursor` or `next-link` (own origin only); `maxPages` ≤ 200, default 10.                                                          |
| `response`      | `itemsPath` to the records, `itemsAs` (`array`, `object`, `entries`), `format` (`json`, `csv`, `text`), `csv` options.                                                   |
| `mapping`       | See [MAPPING.md](MAPPING.md): `externalId`, `observedAt`, `position` or `geometry`, `labels`, `properties`, `motion`, `filter`.                                          |
| `freshness`     | `liveSeconds`, `recentSeconds`, `expireSeconds` — how the world ages this source's objects.                                                                              |
| `credentials`   | Named references: `{ "token": { "secretRef": "my-feed.token", "label": "…", "kind": "token" } }`. The secret lives in the credential store, never in the file.           |
| `attribution`   | `text` (≤ 500 chars), `url`, `licenseId`. Shown wherever the source's objects are.                                                                                       |
| `termsUrl`      | Where the source's terms are.                                                                                                                                            |
| `dataPolicy`    | Optional overrides; a `user-configured` definition cannot open anything (see below).                                                                                     |
| `review`        | `user-configured` (default), `bundled`, `commercially-reviewed`. Set by whoever loads the file, not by the file, for the operator's folder.                              |
| `enabled`       | Whether a reviewed definition is on by default. A user-configured one is enabled from Sources.                                                                           |
| `sourceQuality` | `authoritative`, `crowdsourced`, `derived`, `unknown` (default).                                                                                                         |
| `boundsQuery`   | The URL or query carries `{south}` `{west}` `{north}` `{east}`, filled from the viewport; polls wait for one.                                                            |
| `settings`      | Provider settings shown in Sources, as a bespoke provider declares them.                                                                                                 |

## Data policy: fail closed

Every definition starts from the most conservative policy there is — commercial use
unknown, no redistribution, no offline packs, no export, no raw payloads kept, retention
seven days — and only a reviewed definition (one with a record in
`config/licenses/providers.json`, directive §6–8) may open any of it. A user-configured file
that sets `redistributionAllowed`, `offlinePackAllowed`, `exportAllowed` or
`rawRetentionAllowed` fails validation with the fields named. Attribution is mandatory and is
carried on every observation.

## Endpoints: what a definition may name

`https://` (or `wss://`) to a public host. Not: credentials in the URL, `localhost`, any
`.local`/`.localhost` name, loopback, RFC 1918, link-local or the metadata address.
Redirects are not followed off the host, and a `next-link` is followed only on the
endpoint's own origin. A source on your own network is a local connector (phase `mqtt`,
`files`, `ingest`) with the local-endpoint policy of ADR-003.

## Where definitions go

- Bundled: `resources/connectors/enabled/*.json` in the packaged app (from
  `connectors/enabled/` in the repository once a definition is reviewed). Examples that are
  tested but not shipped enabled are `connectors/examples/`.
- Yours: `<userData>/connectors/*.json` (Windows: `%APPDATA%\WorldView\connectors\`). Files
  are read at startup with `review` forced to `user-configured`; one that does not validate
  is logged (`connector definition rejected`, with the file and the reasons) and skipped, and
  the rest still load. A `*.test.json` beside a definition is its test sidecar, not a
  definition.

## Testing a definition

```
pnpm connector:test connectors/examples/usgs-earthquakes-geojson.json
pnpm connector:test --all                # every example, with its sidecar
pnpm connector:test <file> --live        # also one sample from the real source
pnpm connector:add --url https://…       # draft a definition from a sample
```

See [TESTING.md](TESTING.md) for the sidecar format and the checks the suite runs.
