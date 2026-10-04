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

| Source                                           | Connector             | Guide                                  |
| ------------------------------------------------ | --------------------- | -------------------------------------- |
| HTTPS endpoint answering JSON (or CSV, or text)  | `rest-json`           | [REST-JSON.md](REST-JSON.md)           |
| GeoJSON FeatureCollection                        | `geojson`             | [GEOJSON-CSV.md](GEOJSON-CSV.md)       |
| CSV file or export                               | `csv`                 | [GEOJSON-CSV.md](GEOJSON-CSV.md)       |
| WebSocket sending JSON messages                  | `websocket-json`      | [WEBSOCKET.md](WEBSOCKET.md)           |
| WFS / OGC API – Features                         | `wfs`, `ogc-features` | [ogc.md](ogc.md)                       |
| WMS / WMTS map layers (drawn as overlays)        | `wms`, `wmts`         | [ogc.md](ogc.md)                       |
| ArcGIS FeatureServer / MapServer layer           | `arcgis-feature`      | [arcgis.md](arcgis.md)                 |
| STAC API or static STAC catalogue                | `stac`                | [stac.md](stac.md)                     |
| Local files (GeoJSON, CSV, GPX, KML, TopoJSON)   | `local-file`          | [files.md](files.md)                   |
| Anything else GDAL reads, via your own `ogr2ogr` | `gdal-import`         | [files.md](files.md)                   |
| MQTT broker; rtl_433, OwnTracks, Meshtastic      | `mqtt`                | [mqtt.md](mqtt.md)                     |
| Home Assistant                                   | `home-assistant`      | [home-assistant.md](home-assistant.md) |
| Traccar                                          | `traccar`             | [traccar.md](traccar.md)               |
| Node-RED or anything that can POST               | `http-ingest`         | [ingest.md](ingest.md)                 |

The definitions that ship with the app, and which connector each runs on, are listed in
[README.md](README.md#shipped-definitions).

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
| `endpoint`      | URL (https), method, headers, query, body, credential, `intervalSeconds`, `timeoutSeconds`, `maxBytes`, `emptyStatus`. Polling connectors.                               |
| `websocket`     | URL (wss), subscribe and heartbeat frames, credential, `itemsPath`, `filter`, `flushMs`. Subscription connectors.                                                        |
| `pagination`    | `none`, `page-number`, `offset-limit`, `cursor`, `next-link` or `link-header` (RFC 8288; own origin only); `maxPages` ≤ 200, default 10.                                 |
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
| `boundsQuery`   | The URL or query carries `{south}` `{west}` `{north}` `{east}`, or `{lat}` `{lon}` and a radius (`boundsMaxRadiusKm` caps it), filled from the view; polls wait for one. |
| `settings`      | Provider settings shown in Sources, as a bespoke provider declares them.                                                                                                 |

## Freshness: how old is still live

Without a `freshness` block a definition's objects age by their object type's defaults
(`DEFAULT_FRESHNESS_POLICIES` in `packages/world-model/src/freshness.ts`). An object is LIVE
up to the first age, RECENT up to the second, STALE after that, and leaves the live picture
(history keeps it) after the third; an observation older than the third when it arrives is
not taken into the live picture at all. Set `freshness` when the source reports more or less
often than the type usually does — a station every hour, a tracker every second.

| Object type                                  | LIVE up to | RECENT up to | Leaves after |
| -------------------------------------------- | ---------- | ------------ | ------------ |
| `aircraft`                                   | 30 s       | 90 s         | 10 min       |
| `transit-vehicle`                            | 30 s       | 2 min        | 15 min       |
| `satellite`                                  | 15 s       | 2 min        | 7 days       |
| `sensor`                                     | 1 min      | 10 min       | 24 h         |
| `camera`                                     | 2 min      | 30 min       | never        |
| `vessel`                                     | 3 min      | 15 min       | 3 h          |
| `traffic-segment`                            | 5 min      | 30 min       | 3 h          |
| `weather-station`                            | 30 min     | 3 h          | 24 h         |
| `storm`, `weather-alert`                     | 30 min     | 6 h          | 48 h         |
| `earthquake`                                 | 1 h        | 24 h         | never        |
| `launch`                                     | 1 h        | 24 h         | 30 days      |
| `fire-detection`                             | 3 h        | 24 h         | 7 days       |
| `imagery-scene`                              | 24 h       | 7 days       | 30 days      |
| `airport`, `port`, `place`, `infrastructure` | 1 year     | 3 years      | never        |
| any other type                               | 5 min      | 1 h          | 24 h         |

A weather alert or other object whose source gives an end (`effectiveUntil`) stays until then
whatever its age.

## Data policy: fail closed

Every definition starts from the most conservative policy there is — commercial use
unknown, no redistribution, no offline packs, no export, no raw payloads kept, retention
seven days — and only a reviewed definition (one with a record in
`config/licenses/providers.json`, directive §6–8) may open any of it. A user-configured file
that sets `redistributionAllowed`, `offlinePackAllowed`, `exportAllowed` or
`rawRetentionAllowed` fails validation with the fields named. Retention is capped for every
definition — seven days unless `maxRetentionSeconds` names a number — and a reviewed
definition may set it to `null` for no cap, as a manifest does by leaving the field out; a
longer or uncapped retention is an opened field like the others. Attribution is mandatory
and is carried on every observation.

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
