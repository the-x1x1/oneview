/**
 * @worldview/query-engine — deterministic query execution and search (ADR-010: no LLM).
 *
 *   executeQuery / executeQueryWithHistory / executeEventQuery   WorldQuery → WorldQueryResult
 *   parseSearch                                                  text → ParsedSearch (grammar)
 *   searchWorld                                                  text → ranked SearchResult[]
 *   Gazetteer / StaticGazetteer / CompositeGazetteer / BuiltinGazetteer
 *   geometry helpers shared with the event engine (region intersection)
 */
export {
  executeQuery,
  executeQueryWithHistory,
  executeEventQuery,
  applyObjectQuery,
  type HistoryReader,
  type HistoryReadOptions,
  type EventSource,
  type QuerySources,
  type EventQuerySources,
} from './execute.js';
export {
  resolveObjectField,
  resolveEventField,
  compareValues,
  comparableKind,
  toNumber,
  type FieldValue,
} from './fields.js';
export { matchesFilter, matchesAll } from './filters.js';
export {
  tokenize,
  objectMatchesText,
  eventMatchesText,
  objectSearchStrings,
  eventSearchStrings,
  matchesTokens,
  externalIdOf,
} from './text-match.js';
export {
  geometryPoints,
  geometryBounds,
  geometryIntersectsRegion,
  geometryRepresentativePoint,
  regionCenter,
  regionSamplePoints,
} from './geometry.js';
export {
  StaticGazetteer,
  CompositeGazetteer,
  normalizePlaceName,
  type Gazetteer,
  type GazetteerHit,
  type GazetteerEntry,
  type GazetteerLookupOptions,
  type PlaceKind,
} from './gazetteer.js';
export { BuiltinGazetteer, BUILTIN_GAZETTEER_ENTRIES } from './builtin-gazetteer.js';
export {
  referenceGazetteer,
  referenceEntries,
  isReferenceLabelsFile,
  REFERENCE_LABELS_FORMAT,
  type ReferenceLabelsFile,
} from './reference-gazetteer.js';
export {
  parseCoordinates,
  formatCoordinateLabel,
  type ParsedCoordinate,
  type UnsupportedCoordinate,
} from './coordinates.js';
export {
  parseSearch,
  matchCommands,
  NEAR_RADIUS_M,
  ISS_NORAD_ID,
  type ParsedSearch,
  type SearchIntent,
  type IntentConfidence,
  type ParseContext,
  type CommandMatch,
} from './parse-search.js';
export { searchWorld, type SearchWorldOptions } from './search-world.js';
export {
  TYPE_VOCABULARY,
  DEFAULT_COMMANDS,
  STOP_WORDS,
  typeLabel,
  type TypeVocabulary,
  type CommandDefinition,
} from './vocabulary.js';
export { stableHash } from './hash.js';

export const QUERY_ENGINE_CONTRACT_VERSION = 'architecture-contract-v1';
