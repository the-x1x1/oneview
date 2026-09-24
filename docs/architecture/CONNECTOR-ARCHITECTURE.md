# Connector architecture

How a JSON definition becomes objects on the map, which package owns what, and where the
next connectors plug in. The decision is [ADR-013](../adr/ADR-013-connector-architecture.md);
the user-facing guides are in [docs/connectors](../connectors/README.md).

## Layers

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ apps/desktop                                                                          │
│   main: runtime core loads definitions → providers/registry → ProviderHost            │
│   renderer: Sources, Source Health, credentials — a connector's provider is a provider │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ packages/runtime           connectorDefinitions(): resources/connectors/enabled (bundled,│
│                            review as declared) + <userData>/connectors (user-configured)│
│ providers/registry         connectorProviderFactories(definitions) beside bespoke ones  │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ packages/connector-runtime ConnectorRegistry, loadDefinitionsFrom, the connectors       │
│                            rest-json · geojson · csv · websocket-json · (phase slots)   │
│                            createPaginator, parseCsv, runConnectorSuite               │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ packages/connector-sdk     definitionSchema, parseDefinition, definitionToManifest,     │
│                            compileMapping/mapRecord, TRANSFORMS, readPath,             │
│                            extractRecords, mapRecords → Observation[], Connector type   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ packages/provider-sdk      PollingProvider, WorldProvider, ProviderContext, testing     │
│ packages/provider-runtime  ProviderHost: http, sockets, cache, rate limit, admission    │
│ packages/world-model       Observation, ObjectTypes, schemas                            │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Dependencies point down only. `connector-sdk` knows nothing about the network;
`connector-runtime` reaches it only through `ProviderContext`; the renderer imports neither
(boundary check).

## From file to observation

1. **Load.** `loadDefinitionsFrom(dir, { review?, reservedIds })` reads `*.json` (not
   `*.test.json`), refuses files over 256 KiB, parses, forces `review` for the user folder,
   validates through the registry, and rejects an id already taken by a bespoke provider or
   an earlier file. Problems and warnings are returned, logged by the runtime, and never thrown.
2. **Validate.** `parseDefinition` (schema: types, ranges, the URL policy, object type,
   credential references, policy fail-closed, the mapping compiles) then the connector's own
   `validate` (a `boundsQuery` without placeholders, `{secret}` without a credential, …).
3. **Manifest.** `definitionToManifest` derives the `ProviderManifest` the host, Source
   Health and the legal audit read: transport, capabilities, credentials (keys and labels
   only), refresh policy with a rate limit that covers cadence × pages + retry, freshness for
   the object type, data policy (resolved fail-closed), attribution, `commercialReview` from
   `review`, `enabledByDefault` only for a reviewed and enabled definition, `allowedHosts`
   from the endpoint(s).
4. **Provider.** `createProvider(definition)` returns a `RestJsonProvider` (a
   `PollingProvider`: the host schedules it, `query` fetches pages through `context.http`) or
   a `WebSocketJsonProvider` (`subscribe` opens through `context.sockets`).
5. **Map.** `extractRecords` finds the records; `mapRecords` applies the compiled mapping to
   each, dedupes by external id, drops future timestamps, flags fetch-time, and builds
   observations with the definition's attribution, source quality and policy (raw hash only
   if the policy allows raw retention).
6. **Admit.** The host admits the batch through the same schema and provider-id checks as
   any provider; a fetch in which everything was rejected is MALFORMED and its body is
   invalidated in the cache.

## Adding a connector

A connector is one file in `packages/connector-runtime/src/connectors/` exporting a
`Connector { metadata, validate, createProvider }`, one line in `BUILT_IN_CONNECTORS`
(the registry has a slot per phase), one export line in `src/index.ts` (same), a guide in
`docs/connectors/`, an example definition with a sidecar and fixtures, and a `*.test.ts`
that runs `runConnectorSuite` on the example. It may extend `RestJsonProvider` (as `geojson`
and `csv` do, by filling defaults), extend `PollingProvider` directly, or implement
`WorldProvider` (as `websocket-json` does). It must not add a transport the provider SDK
lacks: a new way onto the network (MQTT, a local listener) is an ADR-003 amendment first,
made by the integrator, because it is what every phase's security review relies on.

## Security properties

- Definitions are data: a path grammar with no wildcards or expressions, a closed transform
  registry, JSON conditions. There is no `eval`, `Function`, template or plugin hook
  anywhere in `connector-sdk` (grep it; the boundary test forbids `node:*` there).
- Endpoints are https/wss to public hosts; the HTTP client's allow-list is derived from the
  definition and enforced by the host, so a definition cannot reach a host it did not name,
  and redirects and `next-link`s never leave the origin.
- Secrets are references; the host attaches them (`query`, `header`, `bearer`, `path`,
  socket `onOpen`). A definition file, a log line and Source Health never contain one.
- Sizes are capped everywhere: definition 256 KiB, body 8 MiB (settable), CSV 100,000 rows
  and 512 fields, 50,000 records a fetch, 128 mapped fields, 256-character paths, socket
  messages 1 MiB.
- Policy fails closed and a user-configured file cannot open it; only a reviewed definition
  with a registry record may, and the license audit checks the two agree.

## What the connector work found that is not yet done

Kept here so the roadmap and the phase briefs can be checked against it.

- Source Health and Sources show a connector's provider as a provider; the connector name
  and the definition file are in the manifest description only. → phase `source-health-ui`.
- The operator's folder is read at startup; no reload, no per-file enable, no validation
  errors in the UI, no "add a source" dialog. → phase `source-health-ui`.
- Credentials for user-configured definitions appear in the credentials UI through the
  manifest; the flow has not been exercised end to end on Windows. → phase `source-health-ui`
  (verification), then `provider-migration`.
- One record → many observations (a route with stops, a station with several sensors),
  string concatenation and conditional values are deliberately absent from the mapping. If
  a real source needs them they are added as named steps (`explode`, `concat`, `when`) with
  the same no-execution property, by the integrator, as an ADR-013 amendment.
- Pagination by RFC 8288 `Link` headers and by time windows; per-host rate budgets shared
  between definitions on the same host (each has its own limiter today).
- Bounds queries take a bounding box only; point-and-radius and tile/quadkey sources are
  bespoke (adsb-lol) until a `boundsQuery` shape for them is designed.
- WebSocket: binary frames, per-message compression, auth by header (the SDK's socket opens
  with a URL and a credential for the frame only).
- Freshness defaults per object type are applied by the state engine when a definition
  sets none; they are not listed in the connector docs yet.
- Definitions loaded from `<userData>` are not signed; bundled ones ride on the installer's
  integrity. Worldpack signing (roadmap) should cover a bundled definition set.
- Offline packs from connector data are refused by policy for user-configured sources; a
  reviewed definition with `offlinePackAllowed` is not yet understood by the pack builder.
- The provider validator's 16 checks and the connector suite's 14 overlap; a bespoke
  provider migrated to a definition must keep its provider contract evidence until the
  suite's report is accepted as equivalent by the release gate.
