# ADR-006 — Hot spatial index: geographic grid cells + exact filtering

Status: Accepted · 2026-09-21 · Package: `@worldview/hot-spatial-index`

## Options considered

| Option                  | Pros                                                                                                    | Cons                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| H3 (h3-js)              | Hierarchical, hex neighbours, well known                                                                | Native/WASM dependency (~1 MB), cell lookups cost µs each, overkill for bbox/radius queries |
| RBush (R-tree)          | Excellent bbox queries                                                                                  | Per-update rebalancing cost for 10k+ moving aircraft; no cheap density aggregation          |
| **Fixed grid (chosen)** | O(1) upsert, trivial density aggregation per cell, zero dependencies, antimeridian handled by splitting | Coarser candidate sets near cell edges (exact filter fixes correctness)                     |

## Decision

`GridSpatialIndex` with 1° cells (configurable) and exact final predicates (`boundsContain`, haversine, point-in-polygon). Queries: within bounds, within radius, nearest N (geometric radius expansion), within region, objects of type within region, per-cell counts (density at global zoom).

## Evidence

`packages/state-engine/src/state-engine.test.ts`: 100,000 random objects insert in < 5 s (measured ≈ 190 ms) and a California bbox query with a type filter completes in < 200 ms (measured single-digit ms). `tools/benchmark` reproduces at 1k/10k/50k/100k.

## Consequences

Cell size is a tuning knob; a hierarchical index can replace this behind the same `SpatialIndex` interface if benchmarks ever justify it.
