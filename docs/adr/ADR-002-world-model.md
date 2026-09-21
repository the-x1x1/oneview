# ADR-002 — Canonical world model

Status: Accepted · 2026-09-21 · Package: `@worldview/world-model`

## Decision
One dependency-free package holds the frozen contracts: `Observation` (a source measurement), `WorldObject` (an entity), `WorldEvent` (something that happened), `Provenance`/`ObservationReference` (relationships back to sources), `WorldQuery` (the single query shape), plus pure functions for freshness, confidence, identifiers, geo and time. All timestamps are UTC ISO 8601 strings. Payloads and properties are plain JSON (`JsonValue`) so they validate, persist and cross IPC unchanged.

Runtime validators (`observationSchema`, `eventSchema`, `worldQuerySchema`) are built on a small in-repo schema combinator (`schema.ts`) because the workspace cannot take a validation dependency and the contract surface is small; every trust boundary (provider output, IPC, worldpack manifests, imported collections) validates with them.

Freshness is per object type (`DEFAULT_FRESHNESS_POLICIES`), overridable per provider; there is no global timeout. Confidence is a documented deterministic score (see `confidence.ts`) displayed only as HIGH/MEDIUM/LOW/UNKNOWN.

## Consequences
Every other package depends on this one and nothing else in the model layer; changing a contract requires a new contract tag and a migration note in docs/EXECUTION-STATUS.md.
