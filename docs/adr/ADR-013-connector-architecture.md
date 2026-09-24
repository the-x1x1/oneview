# ADR-013 — Connector architecture

Status: Accepted · 2026-09-23 · Packages: `@worldview/connector-sdk`, `@worldview/connector-runtime`, `@worldview/tool-connector-validator`

## Context

Every source so far is a hand-written provider (ADR-003): a manifest, a normalizer, fixtures, a
contract plan. That is the right shape for a source with its own protocol — an SDR, a camera
gateway, a satellite propagator — and the wrong one for the thousand open-data feeds that
differ only in a URL, a record path and field names. Writing a provider for each of those
means writing the same twenty lines of `fetch → items → fields → Observation` over and over,
and reviewing them over and over. The acceleration directive asks for sources to become
declarative definitions, with the code that runs them written once, tested once and shared.

## Decision

- **A connector runs a definition; the definition is data.** `packages/connector-sdk` defines
  the definition document (`schema: oneview.connector.v1`): id, name, `connector`,
  `objectType` (a `world-model` object type), `endpoint` or `websocket`, `pagination`,
  `response` (record path, JSON/CSV/text), `mapping`, `freshness`, `credentials`,
  `attribution`, `termsUrl`, `dataPolicy`, `review`, `enabled`, `boundsQuery`. A connector
  (`packages/connector-runtime`) is a `Connector { metadata, validate, createProvider }` that
  turns a validated definition into an ordinary `WorldProvider`. The provider host, admission,
  health, the HTTP client's allow-list, cache, rate limit, credential scoping and every other
  ADR-003 guarantee apply unchanged, because a connector's provider is a provider.
- **Mappings are never executed.** A mapping names paths (a closed grammar: dotted keys,
  `[n]`, `[-1]`, `["quoted"]`, `$`), a fixed transform registry (`number`, `isoTimestamp`,
  `unixSeconds`, `knotsToMps`, `scale:<n>`, `offset:<n>`, `timestamp:<pattern>`, …), literals,
  fallbacks and defaults, and filter conditions (`equals`, `in`, `exists`, `min`, `max`).
  There is no expression language, no `eval`, no template engine, no user JavaScript. A
  transform the registry lacks is added to the registry with a test, not to a definition.
- **Fail closed.** A definition's data policy defaults to commercial use unknown, no
  redistribution, no offline packs, no export, no raw retention, seven-day retention; a
  `user-configured` definition cannot open any of it. `review` (`user-configured` →
  `bundled` → `commercially-reviewed`) maps to `commercialReview`
  (`manual-review-required` → `conditional` → `approved`), and only a reviewed, `enabled`
  definition is on by default. Endpoints are https (wss) to a public host: no credentials in
  the URL, no loopback, private, link-local or metadata addresses (directive §76). Secrets are
  referenced by `secretRef` and attached by the host (`query`, `header`, `bearer`, `path`, or
  `{secret}` in a WebSocket subscribe frame); a definition never holds one.
- **Where definitions live.** Bundled definitions ship in `resources/connectors/enabled`
  (curated, reviewed); the operator's own go in `<userData>/connectors/*.json`, loaded with
  `review` forced to `user-configured`, a 256 KiB cap, and any file that does not validate
  reported in the log and skipped so that one bad file never stops the others. Ids may not
  collide with a bespoke provider or another definition.
- **One suite for every connector.** `runConnectorSuite(definition, fixtures)` runs the same
  checks against any connector: config validation, successful parse, empty and malformed
  responses, timeout, auth failure, rate limit, oversized payload, cancellation, mapping error
  (a poll) or reconnect (a socket), missing fields, attribution, data policy, rate policy.
  `pnpm connector:test <definition>|--all` runs it from a `<name>.test.json` sidecar (fixture
  paths or inline bodies, expected counts, ids and field values — data, not code) and writes
  `artifacts/verification/connectors/<id>.json` as evidence; `--live` fetches one sample
  through the real provider host with secrets from `ONEVIEW_SECRET_<REF>` only.
  `pnpm connector:add --url` drafts a fail-closed definition from one sample.
- **Bespoke providers are frozen, not deleted.** Existing providers keep working unchanged.
  A provider whose whole job a connector can do is a migration candidate
  ([phase `provider-migration`](../roadmap/phases/provider-migration.md)); one with its own
  protocol or device is kept; one that is mostly declarative with one special step becomes a
  hybrid (a definition plus a named transform or a small connector). Nothing is rewritten for
  its own sake.
- **Wave 1** ships `rest-json` (GET/POST, headers, query, credential, JSON/CSV/text bodies,
  page-number, offset-limit, cursor and same-origin next-link pagination, viewport
  placeholders), `geojson`, `csv` and `websocket-json` (subscribe frame, heartbeat, filter,
  items path, batching, reconnect with back-off). Later connectors are built as parallel
  phases (`docs/roadmap/PARALLEL-PHASES.md`), each in its own registry slot.

## Consequences

- Adding an open-data source touches one JSON file, one sidecar and one fixture directory.
  Review moves from reading code to reading a definition and a licence.
- The world model, the provider SDK and the connector SDK are the frozen contracts every
  phase builds on; a change to them is an amendment here (a dated line under Amendments) and
  goes through the integrator, never a phase branch alone.
- The definition schema is versioned by its `schema` id; a `v2` reads `v1` unchanged or
  ships a migration in the loader, and the suite runs both.
- The UI still lists a connector's provider as a provider; showing the connector and the
  definition file behind it, and managing the operator's folder from the app, is
  [phase `source-health-ui`](../roadmap/phases/source-health-ui.md).

## Amendments

- (none yet — one dated line per change to a frozen contract; see docs/roadmap/INTEGRATION.md)
