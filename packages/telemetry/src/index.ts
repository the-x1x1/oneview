/**
 * @worldview/telemetry — the package stub for phase `telemetry` (integrator item #8; the
 * phase owns `packages/telemetry/**` and builds the resolution, the projection over history
 * and the tests here; the Readings section lives in the renderer).
 *
 * The descriptor itself is manifest data, so its type and schema are in the provider SDK
 * (`provider-sdk/telemetry.ts`, ADR-003 amendment): a manifest carries it as `telemetry`, a
 * connector definition as `telemetry` (ADR-013). This package re-exports them so the phase's
 * code and the renderer import one place.
 */
export {
  MAX_TELEMETRY_SERIES,
  TELEMETRY_FORMATS,
  telemetryDescriptorSchema,
  telemetrySeriesSchema,
  type TelemetryDescriptor,
  type TelemetryFormat,
  type TelemetryLimits,
  type TelemetrySeries,
} from '@worldview/provider-sdk';

export const TELEMETRY_PACKAGE_VERSION = '0.1.0';
