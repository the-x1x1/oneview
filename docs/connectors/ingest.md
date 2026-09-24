# HTTP ingest (`http-ingest`)

A source that is pushed to instead of polled. Anything that can make an HTTP request — a
Node-RED flow, a shell script, a Raspberry Pi, a PLC gateway — POSTs records to a listener
OneView opens on `127.0.0.1` while the source runs. This is the way in for sources that
have no API: the operator writes the glue in the tool they already use, and the definition
stays data.

The listener belongs to the host (ADR-003 amendment 2026-09-23,
`ProviderLocalAccess.listen`; THREAT-MODEL T16). The connector names a port and its path;
the host binds, checks the token and caps the traffic. The connector never sees the token.

## A definition

```json
{
  "schema": "oneview.connector.v1",
  "id": "node-red-weather-stations",
  "name": "Weather stations (pushed from Node-RED)",
  "connector": "http-ingest",
  "objectType": "weather-station",
  "mapping": {
    "externalId": "station",
    "observedAt": { "path": "time", "transform": "isoTimestamp" },
    "position": { "lat": { "path": "lat", "transform": "number" }, "lon": { "path": "lon", "transform": "number" } }
  },
  "credentials": {
    "token": { "secretRef": "ingest.node-red-weather-stations.token", "kind": "token" }
  },
  "settings": [{ "key": "port", "label": "Listener port", "kind": "number", "min": 1024, "max": 65535 }],
  "attribution": { "text": "Own weather stations (pushed from Node-RED)" },
  "review": "user-configured",
  "enabled": false
}
```

- **No `endpoint`, `websocket` or `file`.** Nothing is fetched; a definition with one is
  refused. `pagination` and `response` are ignored (with a warning).
- **Exactly one credential**: the bearer token pushers send. Give it `kind: "token"`.
- **The path is `/ingest/<id>`**, from the definition's id. It is not configurable, so a
  flow that posts to the wrong source's URL gets 404, and one that names the wrong
  `source` in its envelope gets 400.
- **`mapping`** reads each record, as for any connector (docs/connectors/MAPPING.md).
- Two complete examples, with fixtures, are in
  `connectors/examples/ingest/awaiting-amendments/` (see _Status_ below).

## Settings

| Setting                | Default | Range      | What it does                                                      |
| ---------------------- | ------- | ---------- | ----------------------------------------------------------------- |
| `port`                 | 47311   | 1024–65535 | The port on 127.0.0.1. **Each ingest source needs its own port.** |
| `maxBodyBytes`         | 1048576 | 1–16 MiB   | A larger push is refused with 413, before it is read.             |
| `maxRequestsPerMinute` | 600     | 1–6000     | Past it the pusher gets 429 with `Retry-After`.                   |

A definition declares the settings it wants the operator to see (as `number` settings in
those ranges; the validator refuses wider bounds). One it does not declare keeps its
default. Changing a setting while the source runs moves the listener: it closes and opens
again on the new port. A value out of range is refused, the listener stays where it was,
and Source Health shows `DEGRADED` with the reason until the setting is put right (or
`ERROR` with the reason, if the source had no listener open at the time — while it was
trying a busy port, say; the retry stops until the setting is valid).

Two sources on the same port cannot both listen: the second one's health says
`port 47311 is already in use on 127.0.0.1`. At start the host tries again with its
backoff; after a settings change the source tries again itself (2 s, doubling to a minute,
with `trying again` in its health) until the port is free, the setting changes or the
source stops. Both examples default to 47311, so give the second one you enable its own
port.

## The token

The token is an ordinary credential. Store it under the definition's `secretRef` in
Sources → Credentials, then give the same value to the pusher (Node-RED's environment, the
script's environment). Until a token is stored, every push gets 401 and the source shows
`AUTH_REQUIRED`. The host reads the token from the credential store on each request, so a
new token applies to the next push without restarting anything (Source Health catches up
at that push: see amendment request A3).

The app cannot generate a token yet (amendment request A2 in the phase brief). Until it
can, make a long random one yourself, for example in PowerShell:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

or `openssl rand -base64 32`.

## The envelope

```json
{
  "schema": "oneview.ingest.v1",
  "source": "node-red-weather-stations",
  "records": [
    {
      "station": "backyard-01",
      "lat": 21.3069,
      "lon": -157.8103,
      "time": "2026-09-23T19:58:00Z",
      "temperature_c": 27.4
    }
  ]
}
```

- `schema` must be `oneview.ingest.v1`; `source` must be the definition's id; `records` is
  an array. Any other field is refused, so a typo fails loudly.
- Glue that cannot wrap its output may send **a bare JSON array** of records instead.
- A push is a **delta**: send the records that changed. Records are merged by
  `externalId`; nothing that is left out is removed. Objects age out with the definition's
  `freshness`.
- **Time**: a record whose `observedAt` mapping finds nothing gets the receipt time and the
  quality flag `fetch-time`. A record timed more than ten minutes in the future is
  rejected.
- At most 10,000 records a push; the rest are rejected with a reason.

## Answers

| Status | When                                                                        | Body                                                                        |
| ------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 202    | The push was taken (some records may have been rejected).                   | `{"accepted":3,"rejected":0,"filtered":0,"timedAtReceipt":0}` (+ `reasons`) |
| 400    | Not UTF-8, not JSON, not the envelope, another source, or no record mapped. | `{"error":"…"}`, and `rejected`/`reasons` when records were the problem     |
| 401    | Missing or wrong bearer token.                                              | `{"error":"missing or wrong bearer token"}`                                 |
| 404    | Another path.                                                               |                                                                             |
| 405    | Not `POST` (`OPTIONS` included, so no browser preflight succeeds).          |                                                                             |
| 413    | Body over `maxBodyBytes`.                                                   |                                                                             |
| 421    | The `Host` header is not `127.0.0.1` or `localhost` with this port.         |                                                                             |
| 429    | Over `maxRequestsPerMinute`; `Retry-After` says when to try again.          |                                                                             |
| 503    | The source is stopping or moving to another port; send again.               |                                                                             |

`reasons` holds at most five `{ "index", "reason" }` entries, so the pusher sees why a record
was dropped without OneView echoing the body back.

## curl

```sh
curl -sS -X POST http://127.0.0.1:47311/ingest/node-red-weather-stations \
  -H "Authorization: Bearer $ONEVIEW_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @fixtures/connectors/ingest/weather-stations-envelope.json
```

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:47311/ingest/node-red-weather-stations `
  -Headers @{ Authorization = "Bearer $env:ONEVIEW_INGEST_TOKEN" } -ContentType application/json `
  -InFile fixtures\connectors\ingest\weather-stations-envelope.json
```

## Node-RED

`fixtures/connectors/ingest/node-red-flow.json` is a flow to import (Menu → Import): an
inject node every 60 s, a function node that builds the envelope and the `Authorization`
header from the `ONEVIEW_INGEST_TOKEN` environment variable, an **http request** node that
POSTs to `http://127.0.0.1:47311/ingest/node-red-weather-stations`, and a debug node
showing OneView's answer. The token is never written into the flow. Node-RED must run on
the same machine as OneView (the listener is loopback only). This flow has not been run
against a real Node-RED yet; the curl requests above have (evidence in the phase brief).

## Source Health

- `STARTING` — `listening on 127.0.0.1:47311/ingest/<id>; no push yet`.
- `LIVE` — the last push, its time, the pusher's `User-Agent` and its counts.
- The last body the source itself refused (400), with its reason.
- The refusals the host made before asking the source (`401×2, 413×1`). These are counted
  by the host's listener and shown the next time Source Health is published — at the next
  push the source answers. A source that only ever gets refused by the host does not
  republish; amendment request A3 asks the host to.
- `DEGRADED` when a setting was refused and the listener stayed where it was.
- `AUTH_REQUIRED` while no token is stored; `ERROR` with the port named when the listener
  could not open (and `trying again` while the source retries).

## What the listener will never do

- Listen on anything but `127.0.0.1`: not the LAN, not `0.0.0.0`, not IPv6. A LAN bind would
  be its own reviewed amendment.
- Speak TLS, keep long-polling connections, accept WebSocket upgrades, or take images or
  files.
- Answer a request without the token, show the token back, or write it to a log.
- Hand the source a request's `Authorization` or `Cookie` header.
- Run anything a push contains: records are data, read by the mapping.
- Stay open when the source is stopped or disabled.

## Status

The connector runs on the listener in `develop` (amendment #7). Three amendment requests
are open in `docs/roadmap/phases/ingest.md`: **A1**, the shared suite's listener mode (until
it lands, the suite cannot drive a pushed source, so the examples wait in
`connectors/examples/ingest/awaiting-amendments/` and `ingest.test.ts` runs the listener
checks), **A2**, generating the token in the app, and **A3**, the host republishing Source
Health after a listener refusal or a credential change.
