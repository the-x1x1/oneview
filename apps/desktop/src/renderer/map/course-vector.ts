import { useEffect, useRef } from 'react';
import type { GeoPosition, WorldObject } from '@worldview/world-model';
import { destinationPoint, splitAtAntimeridian, type RenderFeature } from '@worldview/render-core';
import { CPA_MAX_AGE_S, cpa, cpaPoints, nm, overGround, type Cpa } from '../context/cpa.js';
import { currentTime, useNow } from '../hooks/use-now.js';
import type { RendererHostLike } from '../renderer-host-like.js';
import { greatCircle } from './measure.js';
import { NO_TOOL_LAYER, sendToolLayer, type ToolLayerShown } from './tool-layers.js';

/**
 * The selected ship's or aircraft's course vector: a dashed line from its last report along its
 * course and speed over ground, as far as it goes in the next few minutes, with a tick each so
 * many minutes — where it will be if nothing changes, as a radar or an AIS display draws it.
 * With the operator's own boat on the map (NMEA 2000) and another vessel selected, the boat's
 * vector too, and where the two will be at their closest point of approach, joined.
 * Worked out here from what each reports; map features on their own layer, never pick targets.
 */
export const COURSE_VECTOR_LAYER = 'course-vector';

/** How far ahead (minutes) and a tick every so many: a ship's 12 at 3, an aircraft's 5 at 1. */
export const VECTOR_MINUTES: Readonly<Record<'vessel' | 'aircraft', { span: number; tick: number }>> = {
  vessel: { span: 12, tick: 3 },
  aircraft: { span: 5, tick: 1 },
};
/** Slower than this nothing is drawn (render-core motion.ts: a moored ship's or a hovering helicopter's speed is noise). */
const MIN_SPEED_MPS = { vessel: 0.5, aircraft: 5 } as const;
/** Faster than this the report is taken as bad (60 kn; Mach 3), as motion.ts does. */
const MAX_SPEED_MPS = { vessel: 31, aircraft: 1000 } as const;
/** A closest point further off than this (from now) is not drawn: the vectors say enough. */
const CPA_DRAW_MAX_S = 60 * 60;

export interface Mover {
  kind: 'vessel' | 'aircraft';
  from: GeoPosition;
  courseDeg: number;
  speedMps: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * A ship's course and speed over ground (not its heading: where it goes, not where it points),
 * or an aircraft's reported ground track and speed; undefined on the ground, too slow, without
 * them, or heard more than ten minutes from `atMs` either way.
 */
export function moverOf(o: WorldObject, atMs: number): Mover | undefined {
  if ((o.type !== 'vessel' && o.type !== 'aircraft') || !o.position) return undefined;
  if (o.properties['onGround'] === true) return undefined;
  const heard = Date.parse(o.observedAt);
  // Too old to carry — or, replaying, a report from well after the time shown.
  if (!Number.isFinite(heard) || Math.abs(atMs - heard) > CPA_MAX_AGE_S * 1000) return undefined;
  const kind = o.type;
  let courseDeg: number | undefined;
  let speedMps: number | undefined;
  if (kind === 'vessel') {
    const t = overGround(o);
    courseDeg = num(o.properties['courseDegrees']) !== undefined ? t?.courseDeg : undefined;
    speedMps = t?.speedMps;
  } else {
    courseDeg = o.motion?.headingDegrees;
    speedMps = o.motion?.speedMps;
  }
  if (courseDeg === undefined || speedMps === undefined) return undefined;
  if (speedMps < MIN_SPEED_MPS[kind] || speedMps > MAX_SPEED_MPS[kind]) return undefined;
  return { kind, from: { latitude: o.position.latitude, longitude: o.position.longitude }, courseDeg, speedMps };
}

function vectorFeatures(m: Mover, idPrefix: string, styleClass: string): RenderFeature[] {
  const { span, tick } = VECTOR_MINUTES[m.kind];
  const at = (minutes: number) => destinationPoint(m.from, m.courseDeg, m.speedMps * minutes * 60);
  const end = at(span);
  const out: RenderFeature[] = [];
  splitAtAntimeridian(greatCircle(m.from, { latitude: end.latitude, longitude: end.longitude }, 5_000)).forEach(
    (piece, i) => {
      if (piece.length < 2) return;
      out.push({
        id: `${idPrefix}:line${i ? `:${i}` : ''}`,
        geometry: { kind: 'line', positions: piece },
        style: { styleClass, lineStyle: 'dashed', size: 2 },
        interactive: false,
        priority: 3,
        layer: COURSE_VECTOR_LAYER,
      });
    },
  );
  for (let minutes = tick; minutes <= span; minutes += tick) {
    const p = at(minutes);
    out.push({
      id: `${idPrefix}:tick:${minutes}`,
      geometry: { kind: 'point', position: { latitude: p.latitude, longitude: p.longitude } },
      style: {
        styleClass: `${styleClass}.tick`,
        size: minutes === span ? 5 : 3,
        ...(minutes === span ? { label: `${span} min`, labelPriority: 3 } : {}),
      },
      interactive: false,
      priority: 3,
      layer: COURSE_VECTOR_LAYER,
    });
  }
  return out;
}

/**
 * The features for the selection `selected` (and, for another vessel, the boat `own`) at
 * `nowMs`: nothing for an object that is not moving or does not say how.
 */
export function courseVectorFeatures(
  selected: WorldObject,
  own: WorldObject | undefined,
  nowMs: number,
): RenderFeature[] {
  const m = moverOf(selected, nowMs);
  const out = m ? vectorFeatures(m, 'course-vector', 'course-vector') : [];
  if (!own || own.id === selected.id || selected.type !== 'vessel') return out;
  const ownMover = moverOf(own, nowMs);
  if (ownMover) out.push(...vectorFeatures(ownMover, 'course-vector:own', 'course-vector.own'));
  const c = cpa(own, selected, nowMs);
  if (c && c.tcpaS <= CPA_DRAW_MAX_S) out.push(...cpaFeatures(own, selected, c, nowMs));
  return out;
}

function cpaFeatures(own: WorldObject, other: WorldObject, c: Cpa, nowMs: number): RenderFeature[] {
  const at = cpaPoints(own, other, c, nowMs);
  if (!at) return [];
  const minutes = Math.round(c.tcpaS / 60);
  const out: RenderFeature[] = [];
  splitAtAntimeridian(greatCircle(at.own, at.other, 5_000)).forEach((piece, i) => {
    if (piece.length < 2) return;
    out.push({
      id: `course-vector:cpa:line${i ? `:${i}` : ''}`,
      geometry: { kind: 'line', positions: piece },
      style: { styleClass: c.close ? 'course-vector.cpa-close' : 'course-vector.cpa', lineStyle: 'solid', size: 2 },
      interactive: false,
      priority: 4,
      layer: COURSE_VECTOR_LAYER,
    });
  });
  out.push(
    {
      id: 'course-vector:cpa:own',
      geometry: { kind: 'point', position: at.own },
      style: { styleClass: c.close ? 'course-vector.cpa-close' : 'course-vector.cpa', size: 5 },
      interactive: false,
      priority: 4,
      layer: COURSE_VECTOR_LAYER,
    },
    {
      id: 'course-vector:cpa:other',
      geometry: { kind: 'point', position: at.other },
      style: {
        styleClass: c.close ? 'course-vector.cpa-close' : 'course-vector.cpa',
        size: 5,
        label: `CPA ${nm(c.cpaM)} · ${minutes < 1 ? 'now' : `${minutes} min`}`,
        labelPriority: 4,
      },
      interactive: false,
      priority: 4,
      layer: COURSE_VECTOR_LAYER,
    },
  );
  return out;
}

/**
 * What the features depend on, for redrawing only when that changes: each object's report
 * (its time, position, course and speed, or that it cannot be carried) and, with a closest
 * point drawn, the minute (its label counts down).
 */
export function courseVectorKey(
  selected: WorldObject | null | undefined,
  own: WorldObject | undefined,
  nowMs: number,
): string {
  if (!selected) return '';
  const part = (o: WorldObject) => {
    const m = moverOf(o, nowMs);
    return m
      ? `${o.id}@${o.observedAt}|${m.from.latitude.toFixed(5)},${m.from.longitude.toFixed(5)}|${m.courseDeg.toFixed(1)}|${m.speedMps.toFixed(2)}`
      : '';
  };
  const sel = part(selected);
  if (!own || own.id === selected.id || selected.type !== 'vessel') return sel;
  const mine = part(own);
  return sel || mine ? `${sel}|${mine}|${Math.floor(nowMs / 60_000)}` : '';
}

/**
 * Sends the selection's course vector (and the boat's, and the closest point) and takes it
 * away when the selection changes or stops moving. Its own component, so the minute's tick
 * re-renders only this, not the map. `shownAtMs` is the timeline's time when replaying. The
 * minute's clock decides when to redraw; what is drawn is worked out with the clock as it is
 * then, so the closest point agrees with the panel's.
 */
export function CourseVector({
  host,
  selected,
  own,
  shownAtMs,
}: {
  host: RendererHostLike | undefined;
  selected: WorldObject | null | undefined;
  own: WorldObject | undefined;
  shownAtMs: number | undefined;
}): null {
  const nowMs = useNow(60_000);
  const atMs = shownAtMs ?? nowMs;
  const shown = useRef<ToolLayerShown>(NO_TOOL_LAYER);
  const key = courseVectorKey(selected, own, atMs);
  const input = useRef({ selected, own, shownAtMs });
  input.current = { selected, own, shownAtMs };
  useEffect(() => {
    if (!host?.setFeatures) return;
    sendToolLayer(host, shown, key, () => {
      const { selected: s, own: o, shownAtMs: past } = input.current;
      return key && s ? courseVectorFeatures(s, o, past ?? currentTime()) : [];
    });
  }, [host, key]);
  return null;
}
