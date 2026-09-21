import { computeConfidence, type JsonValue, type WorldObject } from '@worldview/world-model';
import type { IdentityResolver } from '@worldview/identity';
import { rowToObservation, type HistoryRow, type RowToObservationOptions } from './row.js';

/**
 * Rebuild a WorldObject from one history row. Identity is resolved with the same
 * deterministic resolver the live state uses (ADR-011), so a replayed object has the
 * same id as its live counterpart. Freshness is always HISTORICAL and provenance
 * origin 'historical' — replayed data never masquerades as live.
 */
export type ProviderInfoResolver = (providerId: string) => RowToObservationOptions | undefined;

const LABEL_KEYS = ['name', 'callsign', 'registration', 'title', 'place', 'label', 'flight', 'shortName'] as const;

export function rowToWorldObject(row: HistoryRow, identity: IdentityResolver, providerInfo?: ProviderInfoResolver): WorldObject {
  const obs = rowToObservation(row, providerInfo?.(row.providerId));
  const resolution = identity.resolve(obs);
  const obj: WorldObject = {
    id: resolution.objectId,
    type: obs.objectType,
    sourceRefs: [{ observationId: obs.id, providerId: obs.providerId, observedAt: obs.observedAt }],
    observedAt: obs.observedAt,
    updatedAt: obs.observedAt,
    freshness: 'HISTORICAL',
    confidence: computeConfidence({ sourceQuality: obs.quality.sourceQuality, freshness: 'HISTORICAL', providerCount: 1, identityAuthoritative: resolution.authoritative }),
    labels: extractLabels(obs.payload),
    properties: { ...obs.payload },
    provenance: obs.provenance,
  };
  if (obs.position) obj.position = obs.position;
  if (obs.geometry) obj.geometry = obs.geometry;
  const motion = extractMotion(obs.payload);
  if (motion) obj.motion = motion;
  return obj;
}

function extractLabels(payload: Record<string, JsonValue>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const k of LABEL_KEYS) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) labels[k] = v.trim().slice(0, 200);
  }
  return labels;
}

function extractMotion(payload: Record<string, JsonValue>): WorldObject['motion'] | undefined {
  const m: NonNullable<WorldObject['motion']> = {};
  const speed = payload['speedMps'];
  const heading = payload['headingDegrees'] ?? payload['courseDegrees'];
  const vs = payload['verticalSpeedMps'];
  if (typeof speed === 'number' && Number.isFinite(speed)) m.speedMps = speed;
  if (typeof heading === 'number' && Number.isFinite(heading)) m.headingDegrees = ((heading % 360) + 360) % 360;
  if (typeof vs === 'number' && Number.isFinite(vs)) m.verticalSpeedMps = vs;
  return Object.keys(m).length ? m : undefined;
}
