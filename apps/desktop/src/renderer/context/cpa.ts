import type { WorldObject } from '@worldview/world-model';
import { geodesicInverse, type GeoPosition } from '@worldview/world-model';
import { destinationPoint } from '@worldview/render-core';
import { compassPoint } from './object-knowledge.js';

/**
 * Closest point of approach between the operator's own boat (an object that says
 * `ownVessel`, from NMEA 2000) and another vessel: where they will be nearest if both hold
 * their course and speed over ground, and when — the figure a watch officer reads off radar
 * or AIS. Worked out in a flat plane round the boat, good to well under 1% within the 40 nm an
 * AIS receiver hears.
 */

const NM = 1852;
/** Closer than this, sooner than CPA_CLOSE_S: "close". */
export const CPA_CLOSE_M = 0.5 * NM;
export const CPA_CLOSE_S = 30 * 60;

export interface Cpa {
  /** Now, metres and the bearing from the boat. */
  rangeM: number;
  bearingDeg: number;
  /** At the closest point: metres, and seconds from now (≤ 0: they are already opening). */
  cpaM: number;
  tcpaS: number;
  opening: boolean;
  /** Barely moving relative to each other: the range holds. */
  holding: boolean;
  close: boolean;
}

export interface Track {
  latitude: number;
  longitude: number;
  courseDeg: number;
  speedMps: number;
}

/** Below this speed over ground a vessel without a course is taken as lying still (half a knot). */
const STILL_MPS = 0.25;

/**
 * Course and speed over ground — not the heading: a boat crabbing in a cross-tide points one
 * way and goes another, and the heading is where it points. Without a course it counts only
 * when it is barely moving.
 */
export function overGround(o: WorldObject): Track | undefined {
  if (!o.position) return undefined;
  const sog = o.properties['speedMps'];
  const speed = typeof sog === 'number' && Number.isFinite(sog) ? sog : o.motion?.speedMps;
  if (speed === undefined || !Number.isFinite(speed) || speed < 0) return undefined;
  const cog = o.properties['courseDegrees'];
  const course = typeof cog === 'number' && Number.isFinite(cog) ? cog : speed < STILL_MPS ? 0 : undefined;
  if (course === undefined) return undefined;
  return { latitude: o.position.latitude, longitude: o.position.longitude, courseDeg: course, speedMps: speed };
}

/** The boat among `candidates`: an object of type vessel that says it is the operator's own. */
export function ownVesselOf(candidates: readonly WorldObject[]): WorldObject | undefined {
  return candidates.find((o) => o.type === 'vessel' && o.properties['ownVessel'] === true);
}

/**
 * The boat, for a selected vessel that is not the boat: the one the world mirror keeps
 * (`ownVesselId`), else one among the selection's nearby objects (the boat just off screen).
 * The panel and the map ask the same, so they agree.
 */
export function ownVesselFor(
  selected: WorldObject | null | undefined,
  world: {
    objects: ReadonlyMap<string, WorldObject>;
    ownVesselId?: string;
    related: { objects: readonly WorldObject[] };
  },
): WorldObject | undefined {
  if (!selected || selected.type !== 'vessel' || selected.properties['ownVessel'] === true) return undefined;
  const kept = world.ownVesselId !== undefined ? world.objects.get(world.ownVesselId) : undefined;
  const own = kept ?? ownVesselOf(world.related.objects);
  return own && own.id !== selected.id ? own : undefined;
}

/** A report further than this from the time asked about is not carried: nothing is said about it. */
export const CPA_MAX_AGE_S = 10 * 60;
/** Slower than this relative to each other (0.1 kn), the range is holding. */
const HOLDING_MPS = 0.05;

/**
 * Both carried on their course and speed from when each was last heard to `nowMs` (AIS reports
 * come every few seconds to every three minutes, and the boat's own position more often) —
 * back, for a report a little newer than `nowMs` (a clock read a few seconds ago, or a replay
 * still catching up) — then the closest point between them; undefined without a course and
 * speed for both, or with a report more than ten minutes from `nowMs` either way.
 */
export function cpa(own: WorldObject, other: WorldObject, nowMs?: number): Cpa | undefined {
  const a = overGround(own);
  const b = overGround(other);
  if (!a || !b || !own.position || !other.position) return undefined;
  const age = (o: WorldObject) => {
    const at = Date.parse(o.observedAt);
    return nowMs === undefined || !Number.isFinite(at) ? 0 : (nowMs - at) / 1000;
  };
  const ageA = age(own);
  const ageB = age(other);
  if (Math.abs(ageA) > CPA_MAX_AGE_S || Math.abs(ageB) > CPA_MAX_AGE_S) return undefined;
  const g = geodesicInverse(own.position, other.position);
  const vel = (t: Track) => {
    const c = (t.courseDeg * Math.PI) / 180;
    return [t.speedMps * Math.sin(c), t.speedMps * Math.cos(c)] as const;
  };
  const [ax, ay] = vel(a);
  const [bx, by] = vel(b);
  // The other vessel's place relative to the boat now, east and north, metres.
  const θ = (g.initialBearingDeg * Math.PI) / 180;
  const rx = g.distanceM * Math.sin(θ) + bx * ageB - ax * ageA;
  const ry = g.distanceM * Math.cos(θ) + by * ageB - ay * ageA;
  const vx = bx - ax;
  const vy = by - ay;
  const v2 = vx * vx + vy * vy;
  const rangeM = Math.hypot(rx, ry);
  const bearingDeg = ((((Math.atan2(rx, ry) * 180) / Math.PI) % 360) + 360) % 360;
  if (v2 < HOLDING_MPS * HOLDING_MPS)
    return { rangeM, bearingDeg, cpaM: rangeM, tcpaS: 0, opening: false, holding: true, close: false };
  const tcpa = -(rx * vx + ry * vy) / v2;
  const t = Math.max(0, tcpa);
  const cpaM = Math.hypot(rx + vx * t, ry + vy * t);
  const opening = tcpa <= 0;
  return {
    rangeM,
    bearingDeg,
    cpaM,
    tcpaS: tcpa,
    opening,
    holding: false,
    close: !opening && cpaM < CPA_CLOSE_M && tcpa < CPA_CLOSE_S,
  };
}

/**
 * Where each will be at the closest point (for the map): each carried on its course and speed
 * over ground from its own last report to the moment of closest approach. Undefined when they
 * are opening or holding, or either cannot be carried.
 */
export function cpaPoints(
  own: WorldObject,
  other: WorldObject,
  c: Cpa,
  nowMs: number,
): { own: GeoPosition; other: GeoPosition } | undefined {
  if (c.opening || c.holding) return undefined;
  const at = nowMs + c.tcpaS * 1000;
  const carry = (o: WorldObject) => {
    const t = overGround(o);
    const from = Date.parse(o.observedAt);
    if (!t || !o.position || !Number.isFinite(from)) return undefined;
    const p = destinationPoint(
      { latitude: o.position.latitude, longitude: o.position.longitude },
      t.courseDeg,
      (t.speedMps * (at - from)) / 1000,
    );
    return { latitude: p.latitude, longitude: p.longitude };
  };
  const a = carry(own);
  const b = carry(other);
  return a && b ? { own: a, other: b } : undefined;
}

/** "0.4 nm" (under ten), "12 nm". */
export const nm = (m: number) => {
  const v = m / NM;
  return v < 10 ? `${v.toFixed(1)} nm` : `${Math.round(v)} nm`;
};

/** "2.3 nm 045° NE · CPA 0.4 nm in 12 min" — or "· opening", or "· range holding". */
export function cpaText(c: Cpa): string {
  const where = `${nm(c.rangeM)} ${String(Math.round(c.bearingDeg) % 360).padStart(3, '0')}° ${compassPoint(c.bearingDeg)}`;
  if (c.holding) return `${where} · range holding`;
  if (c.opening) return `${where} · opening`;
  const minutes = Math.round(c.tcpaS / 60);
  const when =
    minutes < 1
      ? 'now'
      : minutes < 120
        ? `in ${minutes} min`
        : minutes < 24 * 60
          ? `in ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
          : 'in over a day';
  return `${where} · CPA ${nm(c.cpaM)} ${when}`;
}
