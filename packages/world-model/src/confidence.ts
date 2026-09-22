import type { FreshnessClass } from './freshness.js';
import type { ObservationQuality } from './observation.js';

/**
 * Confidence is system-generated metadata, not scientific certainty.
 *
 * Method (deterministic, documented; never LLM-assigned):
 *
 *   score = clamp01( wQ * sourceQuality + wR * recency + wP * precision + wA * agreement + wI * identity )
 *
 *   sourceQuality : authoritative 1.0 | crowdsourced 0.7 | derived 0.5 | unknown 0.3
 *   recency       : LIVE 1.0 | RECENT 0.75 | STALE 0.4 | HISTORICAL 0.6 | UNKNOWN 0.2
 *   precision     : 1.0 if accuracy ≤ 50 m, 0.8 ≤ 500 m, 0.6 ≤ 5 km, 0.4 otherwise, 0.5 if unreported
 *   agreement     : 1.0 when ≥2 providers deterministically agree on identity, 0.7 single-source
 *   identity      : 1.0 authoritative id (icao24/mmsi/norad/provider event id), 0.5 synthetic/hash id
 *
 *   weights: wQ 0.30, wR 0.30, wP 0.15, wA 0.10, wI 0.15
 *
 * The UI displays the class (HIGH ≥ 0.8, MEDIUM ≥ 0.55, LOW ≥ 0.3, else UNKNOWN), never the raw number,
 * to avoid implying false precision.
 */
export type ConfidenceClass = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface ConfidenceInputs {
  sourceQuality: ObservationQuality['sourceQuality'];
  freshness: FreshnessClass;
  positionAccuracyM?: number | undefined;
  providerCount: number;
  identityAuthoritative: boolean;
}

const WEIGHTS = { quality: 0.3, recency: 0.3, precision: 0.15, agreement: 0.1, identity: 0.15 } as const;

const QUALITY: Record<ObservationQuality['sourceQuality'], number> = {
  authoritative: 1,
  crowdsourced: 0.7,
  derived: 0.5,
  unknown: 0.3,
};
const RECENCY: Record<FreshnessClass, number> = { LIVE: 1, RECENT: 0.75, STALE: 0.4, HISTORICAL: 0.6, UNKNOWN: 0.2 };

export function precisionFactor(accuracyM: number | undefined): number {
  if (accuracyM === undefined || !Number.isFinite(accuracyM)) return 0.5;
  if (accuracyM <= 50) return 1;
  if (accuracyM <= 500) return 0.8;
  if (accuracyM <= 5000) return 0.6;
  return 0.4;
}

export function computeConfidence(inputs: ConfidenceInputs): number {
  const score =
    WEIGHTS.quality * QUALITY[inputs.sourceQuality] +
    WEIGHTS.recency * RECENCY[inputs.freshness] +
    WEIGHTS.precision * precisionFactor(inputs.positionAccuracyM) +
    WEIGHTS.agreement * (inputs.providerCount >= 2 ? 1 : 0.7) +
    WEIGHTS.identity * (inputs.identityAuthoritative ? 1 : 0.5);
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}

export function classifyConfidence(score: number): ConfidenceClass {
  if (!Number.isFinite(score)) return 'UNKNOWN';
  if (score >= 0.8) return 'HIGH';
  if (score >= 0.55) return 'MEDIUM';
  if (score >= 0.3) return 'LOW';
  return 'UNKNOWN';
}
