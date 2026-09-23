# ADR-002 — Canonical world model

Status: Accepted · 2026-09-21 · Package: `@worldview/world-model`

## Decision

One dependency-free package holds the frozen contracts: `Observation` (a source measurement), `WorldObject` (an entity), `WorldEvent` (something that happened), `Provenance`/`ObservationReference` (relationships back to sources), `WorldQuery` (the single query shape), plus pure functions for freshness, confidence, identifiers, geo and time. All timestamps are UTC ISO 8601 strings. Payloads and properties are plain JSON (`JsonValue`) so they validate, persist and cross IPC unchanged.

Runtime validators (`observationSchema`, `eventSchema`, `worldQuerySchema`) are built on a small in-repo schema combinator (`schema.ts`) because the workspace cannot take a validation dependency and the contract surface is small; every trust boundary (provider output, IPC, worldpack manifests, imported collections) validates with them.

Freshness is per object type (`DEFAULT_FRESHNESS_POLICIES`), overridable per provider; there is no global timeout. Confidence is a documented deterministic score (see `confidence.ts`) displayed only as HIGH/MEDIUM/LOW/UNKNOWN.

2026-09-21 amendment (runtime composition): `WorldObject.media` is populated by the state engine from `payload.media` — entries must be `{ kind: image|stream|snapshot|audio, ref, label?, mimeType? }` and invalid entries are dropped, so a camera reference on an object is always one the camera gateway can resolve. The `Observation` type is unchanged: the payload keeps its `media` key.

2026-09-23 amendment (storms): `EventTypes.Storm = 'storm'` — a tropical cyclone as an event, raised by the event engine's `stormRule` from `storm` objects (the NHC provider). Its geometry is the storm's current point; `properties.track` holds its advisory positions (`{ at, latitude, longitude, intensityKt, classification }`, bounded by thinning). `EVENT_TYPE_LABELS.storm = 'Tropical cyclones'`.

## Consequences

Every other package depends on this one and nothing else in the model layer; changing a contract requires a new contract tag and a migration note in docs/EXECUTION-STATUS.md.
