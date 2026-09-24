/**
 * @worldview/telemetry — which readings an object carries and their values over time, for
 * the context panel's Readings section (phase `telemetry`, the Open MCT harvest in
 * docs/architecture/OPENMCT-HARVEST.md).
 *
 * The descriptor itself is manifest data, so its type and schema live in the provider SDK
 * (`provider-sdk/telemetry.ts`): a manifest carries it as `telemetry`, a connector definition
 * as `telemetry` (ADR-013), and both are validated there. This package re-exports only the
 * types. Everything it exports at run time is pure — no Node built-ins, nothing from the
 * provider SDK's index (whose `testing` export imports `node:crypto`) — so the renderer can
 * import it. Validate a descriptor with `telemetryDescriptorSchema` from the provider SDK.
 */
export type { TelemetryDescriptor, TelemetryFormat, TelemetryLimits, TelemetrySeries } from '@worldview/provider-sdk';

export { DEFAULT_READINGS, DISCOVERED_TYPES, KNOWN_READINGS } from './known.js';
export {
  MAX_SERIES,
  discoverReadings,
  hasReading,
  knownSeries,
  resolveTelemetry,
  type ResolvedTelemetry,
  type TelemetryInput,
  type TelemetryOrigin,
} from './resolve.js';
export { FORMAT_RULES, formatReading, limitState, limitText, seriesUnits, type LimitState } from './format.js';
export {
  MAX_POINTS_PER_SERIES,
  downsample,
  gapThreshold,
  limitBands,
  projectReadings,
  readingAt,
  readingsPath,
  valueRange,
  type LimitBand,
  type ReadingPoint,
  type ReadingSource,
  type ReadingWindow,
} from './series.js';
export {
  DEFAULT_SAMPLES,
  MAX_CACHED_SLICES,
  MAX_SAMPLES,
  TARGET_RADIUS_M,
  readings,
  withLatest,
  type HistoryQuery,
  type ReadingsOptions,
  type ReadingsResult,
  type ReadingsTarget,
  type SliceReadings,
} from './history.js';

export const TELEMETRY_PACKAGE_VERSION = '0.1.0';
