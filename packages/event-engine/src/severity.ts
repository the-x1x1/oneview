import { SEVERITY_ORDER, classifyConfidence, type ConfidenceClass, type SeverityClass, type WorldObject } from '@worldview/world-model';

export function severityAtLeast(severity: SeverityClass | undefined, minimum: SeverityClass | undefined): boolean {
  if (!minimum) return true;
  return SEVERITY_ORDER[severity ?? 'INFO'] >= SEVERITY_ORDER[minimum];
}

export function maxSeverity(a: SeverityClass, b: SeverityClass): SeverityClass {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/** Earthquake severity from magnitude (docs/architecture/EVENT-RULES.md). */
export function magnitudeSeverity(magnitude: number | undefined): SeverityClass {
  if (magnitude === undefined || !Number.isFinite(magnitude)) return 'INFO';
  if (magnitude < 3) return 'INFO';
  if (magnitude < 4.5) return 'MINOR';
  if (magnitude < 5.5) return 'MODERATE';
  if (magnitude < 7) return 'SEVERE';
  return 'EXTREME';
}

/** Payload severity strings (NWS/CAP style) → SeverityClass. Unknown → INFO. */
export function payloadSeverity(value: unknown): SeverityClass {
  if (typeof value === 'number') {
    if (value >= 4) return 'EXTREME';
    if (value >= 3) return 'SEVERE';
    if (value >= 2) return 'MODERATE';
    if (value >= 1) return 'MINOR';
    return 'INFO';
  }
  if (typeof value !== 'string') return 'INFO';
  switch (value.trim().toUpperCase()) {
    case 'EXTREME': return 'EXTREME';
    case 'SEVERE': return 'SEVERE';
    case 'MODERATE': return 'MODERATE';
    case 'MINOR': return 'MINOR';
    default: return 'INFO';
  }
}

/** Confidence class of a derived event from its supporting objects (mean score, then the documented classes). */
export function confidenceOf(objects: readonly WorldObject[]): ConfidenceClass {
  if (objects.length === 0) return 'UNKNOWN';
  let sum = 0;
  for (const o of objects) sum += Number.isFinite(o.confidence) ? o.confidence : 0;
  return classifyConfidence(sum / objects.length);
}
