/**
 * @worldview/event-engine — deterministic, rules-based events (ADR-010: no LLM; rules
 * never create observations, decide identity, alter timestamps or invent severity).
 *
 *   EventEngine          WorldState changes / ingestBatch → rules → EventStore
 *   EventStore           bounded in-memory store: get / all / ofType / list(query) / related
 *   rules                earthquake · wildfire-cluster · weather-alert · launch · source-status
 *   WatchZoneEvaluator   zone × event/object intersection → watch-zone-entry events + notifications
 *   FeedBuilder          events → FeedItem[] (relevance, dedupe, bound, recorded flag)
 *   whatChanged          region + time → WhatChangedResult
 *
 * Thresholds are documented in docs/architecture/EVENT-RULES.md.
 */
export {
  EventEngine,
  DEFAULT_RULES,
  type EventEngineOptions,
  type EventChange,
  type EventBatchResult,
} from './engine.js';
export { EventStore, compareEvents, fingerprint, type EventStoreOptions, type UpsertOutcome } from './store.js';
export {
  type ObjectRule,
  type RuleContext,
  derivedProvenance,
  refsOf,
  ENGINE_PROVIDER_ID,
  ENGINE_SOURCE_NAME,
} from './rules/types.js';
export {
  earthquakeRule,
  withMainshock,
  AFTERSHOCK_RADIUS_M,
  AFTERSHOCK_WINDOW_MS,
  MAINSHOCK_MIN_MAGNITUDE,
} from './rules/earthquake.js';
export {
  wildfireClusterRule,
  clusterDetections,
  clusterSeverity,
  CLUSTER_LINK_DISTANCE_M,
  CLUSTER_LINK_WINDOW_MS,
} from './rules/wildfire-cluster.js';
export { weatherAlertRule } from './rules/weather-alert.js';
export { launchRule } from './rules/launch.js';
export {
  stormRule,
  saffirSimpson,
  stormSeverity,
  extendTrack,
  stormTrend,
  STORM_TRACK_MAX,
  type TrackPoint,
} from './rules/storm.js';
export {
  airQualityRule,
  aqiCategoryName,
  aqiSeverity,
  AIR_QUALITY_RAISE_AQI,
  AIR_QUALITY_CLEAR_AQI,
} from './rules/air-quality.js';
export {
  SourceStatusTracker,
  sourceStatusEvent,
  isNotableTransition,
  SOURCE_STATUS_THROTTLE_MS,
  type SourceChange,
} from './rules/source-status.js';
export {
  WatchZoneEvaluator,
  inQuietHours,
  mayInterrupt,
  WATCH_ZONE_DEDUPE_MS,
  type WatchZoneEvaluatorOptions,
  type WatchZoneHit,
  type NotificationPayload,
} from './watch-zones.js';
export { FeedBuilder, feedTime, toFeedItem, FEED_MAX_ITEMS, type FeedBuilderOptions } from './feed.js';
export { whatChanged, type WhatChangedSources } from './what-changed.js';
export { severityAtLeast, maxSeverity, magnitudeSeverity, payloadSeverity, confidenceOf } from './severity.js';
export { convexHull, footprintGeometry, boundsPolygon, boundsOfPoints } from './geometry.js';

export const EVENT_ENGINE_CONTRACT_VERSION = 'architecture-contract-v1';
