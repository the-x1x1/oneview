# Phase `provider-migration` — Classify and migrate bespoke providers

Status: open · Branch: `phase/provider-migration` · Target: 0.2.0 · Owner: (unassigned)

## Goal

Every bespoke provider is classified KEEP, MIGRATE or HYBRID with a reason, the MIGRATE
ones are re-expressed as definitions in `connectors/enabled/` proving the connector layer
carries real sources, and nothing the app does today changes — the bespoke providers stay
registered and on until the integrator decides, per provider, to retire one.

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; [CONNECTOR-ECONOMICS.md](../../architecture/CONNECTOR-ECONOMICS.md);
every `providers/*/src/manifest.ts` and `normalize.ts`; `config/licenses/providers.json`;
`docs/providers/BUILDING-A-PROVIDER.md`; the connector guides.

## Scope

In: `docs/providers/MIGRATION-MATRIX.md` — one row per provider: transport, what it does
that a connector cannot, classification, the definition that would replace it (or the
transform/connector it would need), the evidence that the definition produces the same
observations (ids, positions, payload keys) against the provider's own fixtures. Definitions
for the MIGRATE set in `connectors/enabled/` with sidecars pointing at the existing
`fixtures/<provider>/` files, `review: "bundled"` **requested** (the file says
`user-configured`; the integrator flips it with the registry record), `enabled: false`;
`connectors/examples/migrated/` for the HYBRID ones showing how far a definition gets.

Out: deleting or disabling any bespoke provider; changing `config/licenses/providers.json`
(frozen; the matrix lists the records to add).

## Starting classification (verify, do not trust)

| Provider                                                                             | Transport      | Likely   | Why                                                                                             |
| ------------------------------------------------------------------------------------ | -------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `usgs`                                                                               | http GeoJSON   | MIGRATE  | the reference case; `usgs-earthquakes-geojson` already does it                                  |
| `nhc`                                                                                | http JSON      | MIGRATE? | check the storm/track shapes; may need `explode` (one storm → cone + track + position) → HYBRID |
| `weather` (NWS alerts, stations)                                                     | http GeoJSON   | HYBRID   | zones → geometry join is not a mapping; alerts alone may MIGRATE                                |
| `firms`                                                                              | http CSV, key  | MIGRATE  | `csv` connector with a `path` credential and `boundsQuery`; check the date/time columns         |
| `celestrak`                                                                          | http TLE       | KEEP     | propagation is code                                                                             |
| `adsb-remote`                                                                        | http JSON      | KEEP     | coverage planning by point/radius; a bounds-only definition is HYBRID for a fixed region        |
| `ais` (AISStream)                                                                    | websocket JSON | MIGRATE? | subscribe frame with the key and a bbox; check the message shapes → likely MIGRATE              |
| `cctv-public`                                                                        | http, packs    | KEEP     | camera media, per-pack parsers, gateway                                                         |
| `infrastructure`                                                                     | filesystem     | HYBRID   | phase `files` first                                                                             |
| `readsb-local`, `ais-local`, `purpleair-local`, `weatherlink-local`, `cameras-local` | local          | KEEP     | local-device kit, detection, streams                                                            |

## Deliverables

1. The matrix with evidence per row.
2. Definitions + sidecars for the MIGRATE set; `connector:test --all --dir connectors/enabled`
   green; a comparison test (`connectors/enabled/migration.test.ts`? — no: owned test files
   live under `connectors/examples/migrated/` per ownership; put it there) asserting id/
   position/key parity with the bespoke provider's normalizer on the shared fixtures.
3. Registry records to add, written into the matrix for the integrator.
4. Changelog fragment; status and evidence.

## Definition of done

- [ ] every provider classified with evidence
- [ ] MIGRATE definitions pass the suite and the parity test
- [ ] `phase-check` passes; all common checks green

## Amendment requests

(fill in: transforms or mapping steps a migration needs — e.g. `explode` for NHC)

## Evidence

(filled in at the end)
