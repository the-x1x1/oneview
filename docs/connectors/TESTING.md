# Testing a connector definition

Every connector, and every definition, is proved by the same suite
(`packages/connector-runtime/src/testing/suite.ts`). `pnpm connector:test` runs it from a
test sidecar next to the definition and writes the result as evidence; the same function
runs in unit tests (`packages/connector-runtime/src/connectors.test.ts`) and, for phase
work, in each phase's own `*.test.ts`.

## The sidecar

`connectors/examples/<name>.json` is tested by `connectors/examples/<name>.test.json`:

```json
{
  "schema": "oneview.connector-test.v1",
  "normal": "fixtures/connectors/gbfs-station-information.json",
  "empty": "fixtures/connectors/gbfs-empty.json",
  "malformed": [{ "inline": "not json" }, { "inline": "{\"other\":1}" }],
  "expectObservations": 2,
  "expectIds": ["66db237e-0aca-11e7-82f6-3863bb44ef7c"],
  "expect": [
    {
      "externalId": "66db237e-0aca-11e7-82f6-3863bb44ef7c",
      "observedAt": "2026-09-23T19:41:12.480Z",
      "position": { "latitude": 40.767, "longitude": -73.994, "altitudeM": null },
      "payload": { "kind": "bike-share-station", "capacity": 55 },
      "attribution": "Citi Bike system data (Lyft), GBFS",
      "flags": ["fetch-time"]
    }
  ]
}
```

| Key                  | Meaning                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normal`             | The good response: a fixture path (relative to the repository root) or `{ "inline": "…" }`. A socket connector takes a list of messages.                             |
| `empty`              | A response with no records.                                                                                                                                          |
| `malformed`          | Bodies a poll must report MALFORMED, or messages a socket must ignore.                                                                                               |
| `expectObservations` | How many observations `normal` yields.                                                                                                                               |
| `expectIds`          | External ids that must be among them.                                                                                                                                |
| `expect`             | Per-observation expectations by `externalId`: `observedAt`, `position` (numbers within 1e-6; `null` means absent), `payload` fields, `attribution`, quality `flags`. |

Sidecars are data. A check the sidecar cannot express is written in a `*.test.ts` that calls
`runConnectorSuite` with a `verify` function. Fixtures are recorded from the real source
when the licence allows keeping a sample (most do — a sample is not redistribution), or
invented in the published shape and said to be so in `fixtures/connectors/README.md`.

## The checks

| Check              | A poll connector                                                                                                | A subscription connector                                   | A file connector (a `file` block)                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Config validation  | the definition validates against the schema and the connector's own rules                                       | same                                                       | same, plus the file path rule                                   |
| Successful parse   | `normal` → the expected count, ids and fields; every observation valid, of the definition's object type         | same, through a fixture socket                             | same, `normal` served as the granted file; no HTTP request made |
| Empty response     | no observations, health LIVE                                                                                    | same                                                       | same, as the file                                               |
| Malformed response | each body → MALFORMED                                                                                           | each message ignored; the socket stays open                | each body as the file → MALFORMED                               |
| Timeout            | → TIMEOUT                                                                                                       | open never completes → health OFFLINE, reconnect scheduled | a missing file → UNSUPPORTED                                    |
| Auth failure       | 401 → AUTH                                                                                                      | credential missing → AUTH_REQUIRED, nothing opened         | a path the host refuses → HOST_NOT_ALLOWED, unchanged           |
| Rate limit         | 429 + Retry-After → RATE_LIMITED, honoured                                                                      | —                                                          | a second poll of an unchanged file looks but reads nothing      |
| Oversized payload  | a body over `maxBytes` → refused                                                                                | a message over `maxMessageBytes` → dropped, counted        | a file over `file.maxBytes` → TOO_LARGE before it is read       |
| Cancellation       | an aborted query → CANCELLED, no partial batch                                                                  | unsubscribe closes the socket, nothing emitted after       | same as a poll                                                  |
| Mapping error      | an id path matching nothing → MALFORMED                                                                         | Reconnect: a closed socket reopens with back-off           | same as a poll                                                  |
| Missing fields     | an empty record and an id-only record → rejected with a reason, never a throw, never a positionless observation | same                                                       | same                                                            |
| Attribution        | every observation carries the definition's attribution text                                                     | same                                                       | same                                                            |
| Data policy        | fail-closed defaults; a user-configured definition opens nothing                                                | same                                                       | same                                                            |
| Rate policy        | `maxRequestsPerMinute` covers the cadence and the pages, plus a retry                                           | —                                                          | covers the cadence                                              |

A file connector's fixtures are served through `testing.FixtureLocalAccess` as the file the
definition names — and, for a converter connector (`gdal-import`), as the output of a
`testing.FixtureOgr2ogr` stand-in — so the suite never touches the disk or runs GDAL.

## Running it

```
pnpm connector:test connectors/examples/citibike-stations-rest.json
pnpm connector:test --all                       # connectors/examples and its phase subdirectories
pnpm connector:test --all --dir connectors/enabled
pnpm connector:test <file> --json               # the report as JSON
pnpm connector:test <file> --live               # plus one real sample (network; secrets from the environment)
```

The report is written to `artifacts/verification/connectors/<id>.json`; the exit code is 1
when any definition fails. `--live` registers the definition with the real provider host
(the same HTTP client, allow-list and rate limit as the app), polls once — or listens for
eight seconds to a socket — and reports the health status, counts and one sample. Secrets
come only from `ONEVIEW_SECRET_<SECRET_REF>` (the ref upper-cased, non-alphanumerics as
`_`) and are never printed; a status other than LIVE/DEGRADED/STALE/STARTING fails the run.

## Drafting one

```
pnpm connector:add --url https://data.example.org/things.geojson
pnpm connector:add --url https://… --sample ./saved-response.json --id my-things --type sensor
```

`connector:add` fetches one sample (or reads `--sample`), recognises a GeoJSON
FeatureCollection, a JSON document with an array of records near the top, or CSV, guesses
the record path and the id, time and position fields from their names, and writes
`connectors/drafts/<id>.json` — `user-configured`, disabled, no policy opened, attribution
"to be confirmed" — with a list of what it could not decide. Finish the TODOs, write the
sidecar, run `connector:test`.
