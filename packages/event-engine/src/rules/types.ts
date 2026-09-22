import type { IsoTimestamp, ObservationReference, Provenance, WorldEvent, WorldObject } from '@worldview/world-model';

/**
 * Object rules derive events from objects. Deterministic: the same objects and the
 * same existing events always produce the same event ids and contents (ADR-010).
 */
export interface RuleContext {
  now: number;
  nowIso: IsoTimestamp;
  /** Events already in the store for a type (aftershock linking, cluster identity). */
  existing(type: string): readonly WorldEvent[];
}

export interface ObjectRule {
  id: string;
  /** Object types the rule consumes. */
  objectTypes: readonly string[];
  /** Event types the rule produces. */
  eventTypes: readonly string[];
  /**
   * 'changed': evaluate only objects that changed in this batch (one object → one event).
   * 'all':     evaluate every known object of the rule's types each run (clusters).
   */
  scope: 'changed' | 'all';
  evaluate(objects: readonly WorldObject[], ctx: RuleContext): WorldEvent[];
}

export const ENGINE_PROVIDER_ID = 'worldview';
export const ENGINE_SOURCE_NAME = 'WORLDVIEW event engine';

/** Provenance for a derived event. Recorded (demo) inputs stay labelled recorded — replay never masquerades as live. */
export function derivedProvenance(
  objects: readonly WorldObject[],
  nowIso: IsoTimestamp,
  refs: ObservationReference[],
): Provenance {
  const recorded = objects.some((o) => o.provenance.origin === 'recorded');
  const historical = !recorded && objects.length > 0 && objects.every((o) => o.provenance.origin === 'historical');
  const attribution = [...new Set(objects.map((o) => o.provenance.attribution ?? o.provenance.sourceName))].join('; ');
  return {
    providerId: ENGINE_PROVIDER_ID,
    sourceName: ENGINE_SOURCE_NAME,
    origin: recorded ? 'recorded' : historical ? 'historical' : 'derived',
    receivedAt: nowIso,
    ...(attribution ? { attribution } : {}),
    derivedFrom: refs,
  };
}

export function refsOf(objects: readonly WorldObject[], max = 32): ObservationReference[] {
  const out: ObservationReference[] = [];
  for (const o of objects) {
    for (const r of o.sourceRefs) {
      out.push(r);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function numberProp(o: WorldObject, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o.properties[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

export function stringProp(o: WorldObject, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o.labels[k] ?? o.properties[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** "2026-09-21 03:14 UTC" from an ISO timestamp. */
export function shortUtc(iso: IsoTimestamp): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
