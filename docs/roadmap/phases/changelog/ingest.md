### Added

- **HTTP ingest (`http-ingest`).** Anything that can POST — a Node-RED flow, a script, a Raspberry Pi, a gateway — can
  push records into a source: while the source runs, the host listens for it on `127.0.0.1` only, at
  `/ingest/<source id>`, on the port in the source's `port` setting (default 47311), and takes a `POST` only with the
  source's bearer token. A push is the `oneview.ingest.v1` envelope (`schema`, `source`, `records`) or a bare JSON array;
  each record goes through the definition's mapping and lands as a delta. The pusher gets `202` with accepted, rejected
  and filtered counts (and up to five reasons), or `400` with why; the host's own refusals are `401` (token), `404`,
  `405`, `413` (size, 1 MiB by default), `421` (Host) and `429` (rate, 600 a minute by default). Records without a time
  get the receipt time and the `fetch-time` flag. Source Health shows where the source listens, the last push, the
  pusher's User-Agent, and what was refused. Changing the port setting moves the listener. Guide:
  `docs/connectors/ingest.md`, with curl, PowerShell and a Node-RED flow to import.
