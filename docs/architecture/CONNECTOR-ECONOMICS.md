# Connector economics

Why the connector layer exists, in numbers that can be checked against the repository.

## The cost of a bespoke provider

`providers/usgs` — the reference provider, the simplest there is — is a manifest, a
normalizer, a provider class, a contract plan, fixtures and tests: about 450 lines of
TypeScript plus fixtures, a registry record and a line in the provider registry. Reviewing it
means reading code. Every one of the ten HTTP providers repeats the same fetch → items →
fields → Observation shape with different names, and every fix to that shape (a future
timestamp, a duplicate id, an oversized body) had to be made in each.

## The cost of a definition

`connectors/examples/usgs-earthquakes-geojson.json` does the same job in 40 lines of JSON
that a reviewer reads in a minute, with no code to audit, and inherits every fix made to the
`geojson` connector. Its evidence is the same shared suite every other definition runs.

| Source added as… | Files touched                                                                | Code to review | Tests written              |
| ---------------- | ---------------------------------------------------------------------------- | -------------- | -------------------------- |
| bespoke provider | providers/<id>/ (6–10 files), fixtures/<id>/, registry record, registry line | ~450 lines     | contract plan + unit tests |
| definition       | 1 JSON, 1 sidecar, fixtures/connectors/<id>/                                 | 0 lines        | the sidecar (data)         |

## What stays bespoke, and why

A connector pays for itself when many sources share a protocol. A source with its own
protocol or device does not: an SDR (readsb, AIS), a serial or TCP NMEA feed, a camera
gateway, a satellite propagator, a source that needs point-and-radius coverage planning
(adsb-lol). Those keep their providers. The classification of every existing provider is in
[phase `provider-migration`](../roadmap/phases/provider-migration.md).

## What the layer costs

- Two packages (`connector-sdk` ~1,400 lines, `connector-runtime` ~1,400 lines) and a tool,
  all tested; a fixed transform registry to maintain; a definition schema to version.
- A second review surface: definitions must be reviewed for their licence exactly as
  providers are (directive §6–8). The fail-closed default makes an unreviewed definition safe
  to load, but not useful to ship; review is the bottleneck that the layer does not remove.
- A ceiling: what the mapping cannot express (arithmetic across fields, one record → many)
  is a deliberate limit, so some sources need a small transform added to the registry
  before a definition can carry them.

## What it buys

- Every source in the acceleration directive's harvest list (OGC, ArcGIS, STAC, MQTT,
  Home Assistant, Traccar, Node-RED, rtl_433) becomes a connector plus definitions, so
  covering a new city, agency or device family is a definition, not a release.
- Sources the operator adds themselves without waiting for a release, with the same
  policy and health as bundled ones.
- One place to harden: a size cap, an SSRF rule or a rate-limit fix lands in the connector
  and covers every definition.
