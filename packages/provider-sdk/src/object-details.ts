import type { JsonValue } from '@worldview/world-model';
import type { WorldProvider } from './provider.js';

/**
 * Object details on demand (ADR-003 amendment 2026-09-27, the companion of object-track.ts) —
 * optional and additive: no existing type changed, `WorldProvider` itself untouched. A
 * provider that knows more about one object than its polls carry, or can work something out
 * about it that depends on where the operator is looking, implements `objectDetails`; the
 * host asks it only for the object the operator has selected.
 *
 * Why not put it in the poll: the answer is either a lookup that would cost the source one
 * request per object if done for every object (a satellite's catalogue record — CelesTrak's
 * SATCAT — for ten thousand satellites every couple of hours), or a computation that depends
 * on the observer (a satellite's next passes over the view centre), which a poll does not
 * have. Asked for one selected object, both are cheap and polite.
 *
 * The answer is plain JSON under `properties`, in the same vocabulary a provider's payload
 * uses, so the context panel reads it with the same typed readers it uses for properties.
 * `label` names where it came from and `attribution` is the licence line the source requires;
 * both are shown with it.
 */
export interface ObjectDetailsRequest {
  /** WORLDVIEW object id (`satellite:norad:25544`). */
  objectId: string;
  objectType: string;
  /** The source's own id for the object (the provider's `externalId`), when known. */
  externalId?: string;
  /** The object's current properties (payload), e.g. a satellite's element set. */
  properties: Readonly<Record<string, JsonValue>>;
  /**
   * The point on the ground the operator is looking from: the view centre, or a point the
   * operator chose. Absent when the host knows none. Used for observer-relative answers
   * (a satellite's passes); a provider without such answers ignores it.
   */
  observer?: { latitude: number; longitude: number; altitudeM?: number };
  /** The host's clock (ms) — propagation and "next" are relative to this. */
  nowMs: number;
  signal: AbortSignal;
}

export interface ObjectDetailsAnswer {
  /** Short human label for where the details came from, e.g. "CelesTrak SATCAT". */
  label: string;
  /** Licence/attribution line the source requires, shown with the details. */
  attribution?: string;
  /** An https page about the object at the source (on a host the manifest allows). */
  sourceUrl?: string;
  /** The details, as JSON in the provider's payload vocabulary. */
  properties: Record<string, JsonValue>;
}

export interface ObjectDetailsSource {
  /**
   * Resolve undefined when the provider has nothing for this object. Throwing is allowed;
   * the host logs it and the panel shows the object without the answer.
   */
  objectDetails(request: ObjectDetailsRequest): Promise<ObjectDetailsAnswer | undefined>;
}

export function isObjectDetailsSource(provider: WorldProvider): provider is WorldProvider & ObjectDetailsSource {
  return typeof (provider as Partial<ObjectDetailsSource>).objectDetails === 'function';
}

/** Hard cap on one answer's serialised properties; a larger answer is dropped whole. */
export const MAX_OBJECT_DETAILS_BYTES = 32 * 1024;
