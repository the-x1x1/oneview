/**
 * @worldview/world-model — canonical world model (architecture-contract-v1).
 *
 * THE WORLD
 *   ├── Places        (objects of type place/airport/port/infrastructure)
 *   ├── Observations  (Observation)
 *   ├── Objects       (WorldObject)
 *   ├── Events        (WorldEvent)
 *   ├── Relationships (ObservationReference, WorldLink, event.objectIds)
 *   ├── Sources       (Provenance; provider manifests live in provider-sdk)
 *   └── Time          (IsoTimestamp, TimeRange, freshness)
 *
 * Zero runtime dependencies. Pure types and pure functions only.
 */
export * from './json.js';
export * from './geo.js';
export * from './time.js';
export * from './provenance.js';
export * from './observation.js';
export * from './object.js';
export * from './event.js';
export * from './freshness.js';
export * from './confidence.js';
export * from './identifiers.js';
export * from './query.js';
export * from './schema.js';
export * from './validate.js';

export const WORLD_MODEL_CONTRACT_VERSION = 'architecture-contract-v1';
