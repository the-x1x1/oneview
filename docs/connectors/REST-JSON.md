# REST JSON connector (`rest-json`)

Polls an HTTPS endpoint and maps what it answers. JSON by default; CSV and plain text with
`response.format`. GET or POST, headers, query parameters, a credential the host attaches
(the definition never sees it), pagination, viewport placeholders. Conditional requests,
the cache, the host allow-list, timeouts, retries and the rate limit come from the
provider host as for any provider.

```json
{
  "schema": "oneview.connector.v1",
  "id": "citibike-nyc-stations",
  "name": "Citi Bike stations (New York)",
  "connector": "rest-json",
  "objectType": "infrastructure",
  "endpoint": {
    "url": "https://gbfs.citibikenyc.com/gbfs/en/station_information.json",
    "intervalSeconds": 600
  },
  "response": { "itemsPath": "data.stations" },
  "mapping": {
    "externalId": "station_id",
    "position": { "lat": "lat", "lon": "lon" },
    "labels": { "name": "name" },
    "properties": { "capacity": { "path": "capacity", "transform": "integer" } }
  },
  "attribution": { "text": "Citi Bike system data (Lyft), GBFS" },
  "review": "user-configured",
  "enabled": false
}
```

## `endpoint`

| Key               | Meaning                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`             | `https://` to a public host. `{south}` `{west}` `{north}` `{east}` are filled from the viewport when `boundsQuery` is set; `{TOKEN}` marks where a `path` credential goes. |
| `method`          | `GET` (default) or `POST`.                                                                                                                                                 |
| `headers`         | Sent as given (`Accept` is set from the format unless you override it).                                                                                                    |
| `query`           | Added to the URL; values may carry the viewport placeholders.                                                                                                              |
| `body`            | For POST: a JSON value (sent as `application/json`) or a string (`text/plain`).                                                                                            |
| `credential`      | `{ "name": "<key of credentials>", "as": "query" \| "header" \| "bearer" \| "path", "param": "<name>" }`.                                                                  |
| `intervalSeconds` | Poll cadence; at least 5, default 60. The rate limit is derived from it (twice the cadence × pages, plus a retry).                                                         |
| `timeoutSeconds`  | Per request; default 20.                                                                                                                                                   |
| `maxBytes`        | Per response; default 8 MiB. Larger bodies are refused as oversized.                                                                                                       |

## `response`

| Key         | Meaning                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `itemsPath` | Path to the records: an array, or one object (a single record). Default: the body itself.                                               |
| `itemsAs`   | `array` (default) or `entries` — the value at `itemsPath` is an object keyed by id; each value becomes a record with its key as `_key`. |
| `format`    | `json` (default), `csv` (see [GEOJSON-CSV.md](GEOJSON-CSV.md)), `text` (one record `{ text, url }`).                                    |

A body that is not JSON, has nothing at `itemsPath`, or in which every record is rejected
by the mapping is reported MALFORMED; the cached copy is invalidated so it is never served
as a stale fallback, and Source Health shows the reason.

## `pagination`

| Strategy       | Keys                                                                 | Stops when                                                                      |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `none`         | —                                                                    | after one request (default)                                                     |
| `page-number`  | `pageParam`, `sizeParam?`, `size?`, `firstPage?` (default 1)         | a page is empty or shorter than `size`                                          |
| `offset-limit` | `offsetParam`, `limitParam`, `limit`                                 | a page is shorter than `limit`                                                  |
| `cursor`       | `cursorParam`, `cursorPath` (in the body)                            | the body has no cursor, or a page is empty                                      |
| `next-link`    | `nextLinkPath` (in the body; relative links resolve against the URL) | there is no link, or it leaves the endpoint's origin (never followed elsewhere) |

`maxPages` caps every strategy (default 10, at most 200). Pages are merged into one snapshot;
a duplicate `externalId` across pages keeps the first. The rate limit accounts for the pages.

## Viewport (`boundsQuery: true`)

The URL or a query value must carry at least one of `{south}` `{west}` `{north}` `{east}`
(five-decimal degrees, filled from the viewport the renderer reports). Until there is a
viewport the poll is skipped and Source Health says so. A globe-wide view sends the whole
world; a source that wants a point and a radius instead is a bespoke provider for now
(`adsb-lol` is the model).

## Credentials

```json
"credentials": { "apiKey": { "secretRef": "my-source.apiKey", "label": "My source API key", "kind": "api-key", "helpUrl": "https://…" } },
"endpoint": { "url": "https://api.example.org/v1/things", "credential": { "name": "apiKey", "as": "header", "param": "X-API-Key" } }
```

The credential appears in Sources under the definition's name; the secret is stored in the
OS credential store and attached by the HTTP client. `as: "query"` needs `param`; `as:
"bearer"` sends `Authorization: Bearer …`; `as: "path"` substitutes `{TOKEN}` in the URL.
A 401/403 is reported as AUTH_REQUIRED, a 429 as RATE_LIMITED honouring `Retry-After`.

## Health

LIVE after a successful fetch; the message counts records the mapping rejected or filtered
on the last fetch. STALE when the last good body is older than the freshness policy allows;
ERROR/AUTH_REQUIRED/RATE_LIMITED/OFFLINE as the provider host classifies failures. Nothing
is ever invented to fill a gap (directive §138).
