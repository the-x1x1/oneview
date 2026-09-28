import type { JsonValue, TimeRange } from '@worldview/world-model';
import type { WorldProvider } from './provider.js';

/**
 * Object tracks on demand (ADR-003 amendment 2026-09-27) — optional and additive: no
 * existing type changed, and `WorldProvider` itself is untouched. A provider that can say
 * more about one object than its polls carry implements `objectTrack`; the host asks it
 * only for the object the operator has selected, and only while the timeline is live.
 *
 * Two kinds of answer:
 *
 *   history    — where the object was, from the source's own record of it (adsb.lol keeps
 *                about a day of positions per aircraft). Merged into the track WORLDVIEW
 *                recorded itself, filling the gaps it has — before the aircraft came into
 *                view, or while the view was elsewhere.
 *   prediction — where it will be, computed (one orbital period of a satellite, SGP4 from
 *                the element set the object already carries). Never an observation: the
 *                points are marked predicted wherever they go.
 *
 * Every point of an answer is labelled with `label`, so the context panel can say where
 * the points it shows came from; `attribution` is the licence line the source requires.
 */
export interface ObjectTrackRequest {
  /** WORLDVIEW object id (`aircraft:icao24:a1b2c3`). */
  objectId: string;
  objectType: string;
  /** The source's own id for the object (the provider's `externalId`), when known. */
  externalId?: string;
  /** The object's current properties (payload), e.g. a satellite's element set. */
  properties: Readonly<Record<string, JsonValue>>;
  /** The window the operator asked for; a history answer outside it is dropped. */
  time: TimeRange;
  signal: AbortSignal;
}

export interface ObjectTrackPoint {
  observedAt: string;
  latitude: number;
  longitude: number;
  altitudeM?: number;
}

export interface ObjectTrackAnswer {
  kind: 'history' | 'prediction';
  /** Short human label for every point of the answer, e.g. "adsb.lol history". */
  label: string;
  /** Licence/attribution line the source requires, shown with the label. */
  attribution?: string;
  points: ObjectTrackPoint[];
}

export interface ObjectTrackSource {
  /**
   * Resolve undefined when the provider has nothing for this object (not its object, no
   * id it can look up, nothing recorded). Throwing is allowed; the host logs it and the
   * track is shown without the answer.
   */
  objectTrack(request: ObjectTrackRequest): Promise<ObjectTrackAnswer | undefined>;
}

export function isObjectTrackSource(provider: WorldProvider): provider is WorldProvider & ObjectTrackSource {
  return typeof (provider as Partial<ObjectTrackSource>).objectTrack === 'function';
}

/** Hard cap on the points one answer may carry; the host drops the rest (oldest first). */
export const MAX_OBJECT_TRACK_POINTS = 5_000;
