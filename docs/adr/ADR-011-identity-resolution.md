# ADR-011 — Deterministic identity resolution

Status: Accepted · 2026-09-21 · Package: `@worldview/identity`

## Decision
Object ids are `<type>:<namespace>:<value>`. Authoritative joins: `aircraft:icao24`, `vessel:mmsi`, `satellite:norad`, `earthquake:usgs`, `airport:icao` (exactly four letters; digits and missing codes fall back to provider-scoped), plus provider-declared event ids and official infrastructure ids registered as explicit rules. Anything else is provider-scoped (`<type>:<providerId>:<externalId>`). No fuzzy matching on names or positions; uncertain identity keeps objects separate. Display names are never identity. Adding a join rule requires a test proving it cannot false-merge.
