# Phase `ingest` — HTTP ingest (Node-RED and anything that can POST)

Status: open · Branch: `phase/ingest` · Target: 0.2.0 · Owner: (unassigned)

## Goal

Anything the operator can make emit HTTP — a Node-RED flow, a script, a Raspberry Pi, a
PLC gateway — can push observations in a documented envelope to a listener WORLDVIEW opens
on loopback, off by default, with a token. This is the escape hatch for every source that
has no API: the operator writes the glue in whatever they already use, and WORLDVIEW stays
declarative.

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; ADR-003 (nothing listens today —
this phase asks for the one exception, tightly bounded); ADR-010 (the security posture);
`packages/connector-runtime/src/connectors/websocket-json.ts` (batching, health).

## Scope

In: `http-ingest` — a definition names a path (`/ingest/<id>`), the listener binds
`127.0.0.1` only on a port from the provider settings (default 47311), a bearer token by
credential reference generated and shown once in the settings, `POST` of the envelope
`{ "schema": "oneview.ingest.v1", "source": "<id>", "records": [ … ] }` (records mapped by
the definition's mapping like any connector; also accepts a bare array), size and rate caps,
`202 Accepted` with counts, `401`/`413`/`429`/`400` with reasons, health showing the last
receipt and the pusher's user agent; a Node-RED example flow (JSON) and a curl example in the
docs.

Out: anything but loopback (a LAN bind is a later, reviewed amendment); TLS; long-polling;
WebSocket ingest; ingest of images or files.

## Deliverables

1. Amendment request written first (below); the connector built against a
   `ProviderLocalAccess.listen` shim in the phase's directory that matches the requested
   contract; the suite passes through the shim.
2. `packages/connector-runtime/src/connectors/ingest/{http-ingest,envelope}.ts`, `index.ts`;
   slot lines.
3. Examples with sidecars and fixtures under `connectors/examples/ingest/`,
   `fixtures/connectors/ingest/` (envelopes: good, empty, malformed, oversized, wrong token).
4. `docs/connectors/ingest.md`: the envelope, the token, ports, limits, Node-RED and curl
   examples, what the listener will never do.
5. `ingest.test.ts`: suite; envelope validation; token; caps; the listener never binds
   off-loopback (the shim asserts the bind address).
6. Changelog fragment; status and evidence.

## Definition of done

- [ ] `connector:test --all` green through the shim
- [ ] a real POST from Node-RED or curl pasted once the amendment lands
- [ ] `phase-check` passes; all common checks green

## Design notes

- Records are snapshots per push? No: an ingest push is a delta (the pusher sends what
  changed). Use `snapshot: false` semantics — check what the provider host offers for
  non-snapshot batches (`ObservationBatch.snapshot`); if a subscription provider's emit is
  already delta, mirror `websocket-json`.
- Timestamps: the envelope may carry `observedAt` per record; absent → receipt time,
  flagged.
- The token is a credential; the settings UI shows "regenerate", never the value twice.

## Amendment requests

- **ADR-003: landed** (2026-09-23 amendment, integrator item #7). The shape differs from
  the request in two places, both to keep the token out of the provider:
  `context.local.listen?({ port, path, credential: { key }, maxBodyBytes?, maxRequestsPerMinute?, signal? },
handler: (req: { method, headers, body: Uint8Array, remote }) → { status, body?, headers? })`
  → `{ port, received, refused, close() }`. The runtime binds `127.0.0.1` itself and does the
  token comparison, the path/method/size/rate/Host refusals (404/405/413/429/421/401) before
  the handler is asked, and strips `Authorization` and `Cookie`; the handler sees only
  admitted requests. Offered to `local-process` providers only, one per source, closed on
  stop. Build against `testing.FixtureLocalAccess`: set `listenerSecrets[key]`, open with
  `listen`, drive with `simulateRequest({ token, body, path?, method?, headers? })` — the same
  admission rules (`ListenerGate`) as the app. No shim needed: start from `develop`.

## Evidence

(filled in at the end)
