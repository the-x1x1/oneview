# GeoJSON and CSV connectors

Both are the REST JSON connector with defaults filled in: everything in
[REST-JSON.md](REST-JSON.md) — endpoint, credential, pagination, viewport placeholders,
health — applies.

## `geojson`

The body is a FeatureCollection. Defaults: `response.itemsPath` is `features`;
`mapping.externalId` is the feature's `id`, falling back to `properties.id`;
`mapping.position` is the feature's `geometry` (a Point's coordinates; the first coordinate
of a line or polygon). A definition may override any of them — USGS sets
`"position": { "geometry": "geometry", "altitude": false }` because the third coordinate is a
depth in kilometres, not an altitude.

```json
{
  "schema": "oneview.connector.v1",
  "id": "usgs-earthquakes-connector",
  "connector": "geojson",
  "objectType": "earthquake",
  "endpoint": {
    "url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
    "intervalSeconds": 300
  },
  "mapping": {
    "externalId": "id",
    "observedAt": { "path": "properties.time", "transform": "unixMillis" },
    "position": { "geometry": "geometry", "altitude": false },
    "properties": { "magnitude": { "path": "properties.mag", "transform": "number" } }
  },
  "attribution": { "text": "U.S. Geological Survey Earthquake Hazards Program (public domain)" }
}
```

Lines and areas: set `mapping.geometry` to `geometry` as well, and the observation carries
the whole geometry for renderers that draw it; `position` stays the representative point.

## `csv`

The body is CSV (RFC 4180 quoting, any single-character delimiter, CRLF or LF, a BOM).
Rows become records keyed by the header row, or by `response.csv.columns` when the file has
none; empty cells are absent; every cell is a string, so `number` / `integer` / time
transforms type the fields you use. Positions accept numeric strings directly.

```json
"connector": "csv",
"response": { "format": "csv", "csv": { "delimiter": ",", "header": true, "maxRows": 100000 } },
"mapping": {
  "externalId": "id",
  "observedAt": { "path": "time", "transform": "isoTimestamp" },
  "position": { "lat": "latitude", "lon": "longitude" },
  "properties": { "magnitude": { "path": "mag", "transform": "number" } }
}
```

`maxRows` (default 100,000) drops and counts the rest; more than 512 fields in a row, or an
unterminated quote, is MALFORMED. A row with more cells than columns keeps the extras as
`_<index>`.
