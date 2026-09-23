import { MOTION_MAX_T, type RenderMotion } from '@worldview/render-core';
import type { Cartesian3Like } from '../cesium-like.js';

/**
 * Markers that move between two known positions (RenderFeature.motion — a satellite's
 * position at this poll and at the next, both SGP4; an aircraft's or ship's last report and
 * where its speed and track carry it), placed by wall-clock time.
 *
 * Without this a satellite stood still for fifteen seconds and then jumped ~110 km: every
 * low orbit on the globe moved in steps. The step between the two ends is drawn along the
 * chord, which for a low orbit over 15 s is ~0.2 km inside the true arc. Before the first
 * end it is held there; past the second it carries on along the same line for one more
 * step at most (the next poll is late), then holds — it never runs on indefinitely.
 */
export interface MovingMarker {
  /** Put the marker at a position (the scratch vector is reused: copy it if it is kept). */
  place(position: Cartesian3Like): void;
  /** Whether the marker is drawn at all (the horizon test hides the far side's). */
  shown(): boolean;
  from: Cartesian3Like;
  to: Cartesian3Like;
  fromMs: number;
  toMs: number;
  /** Straight-line speed between the two ends, m/s. */
  speedMps: number;
}

/** How far past the second position a late marker is carried: one more step. */
const MAX_T = MOTION_MAX_T;

export class Movers {
  private readonly items = new Map<string, MovingMarker>();
  private readonly scratch: Cartesian3Like = { x: 0, y: 0, z: 0 };
  private fastest: number | undefined = 0;

  constructor(private readonly wallNow: () => number) {}

  get size(): number {
    return this.items.size;
  }

  /**
   * The fastest registered marker's speed (m/s): what paces the steps. Aircraft alone need a
   * step a twenty-fifth as often as satellites for the same half pixel.
   */
  get maxSpeedMps(): number {
    if (this.fastest === undefined) {
      let max = 0;
      for (const m of this.items.values()) if (m.speedMps > max) max = m.speedMps;
      this.fastest = max;
    }
    return this.fastest;
  }

  /** Register (or replace) a moving marker and put it where it is now. */
  set(
    key: string,
    marker: Omit<MovingMarker, 'fromMs' | 'toMs' | 'speedMps'>,
    motion: Pick<RenderMotion, 'fromMs' | 'toMs'>,
  ): void {
    const span = (motion.toMs - motion.fromMs) / 1000;
    const dx = marker.to.x - marker.from.x;
    const dy = marker.to.y - marker.from.y;
    const dz = marker.to.z - marker.from.z;
    const speedMps = span > 0 ? Math.sqrt(dx * dx + dy * dy + dz * dz) / span : 0;
    const m: MovingMarker = { ...marker, fromMs: motion.fromMs, toMs: motion.toMs, speedMps };
    const previous = this.items.get(key);
    this.items.set(key, m);
    if (previous && previous.speedMps >= (this.fastest ?? 0)) this.fastest = undefined;
    else if (this.fastest !== undefined && speedMps > this.fastest) this.fastest = speedMps;
    this.move(m, this.wallNow());
  }

  delete(key: string): void {
    const m = this.items.get(key);
    if (!m) return;
    this.items.delete(key);
    if (this.fastest !== undefined && m.speedMps >= this.fastest) this.fastest = undefined;
  }

  clear(): void {
    this.items.clear();
    this.fastest = 0;
  }

  /** Move every shown marker to where it is at `nowMs`; returns how many were moved. */
  step(nowMs: number = this.wallNow()): number {
    let moved = 0;
    for (const m of this.items.values()) {
      if (!m.shown()) continue;
      this.move(m, nowMs);
      moved++;
    }
    return moved;
  }

  private move(m: MovingMarker, nowMs: number): void {
    const t = Math.max(0, Math.min(MAX_T, (nowMs - m.fromMs) / (m.toMs - m.fromMs)));
    const s = this.scratch;
    s.x = m.from.x + (m.to.x - m.from.x) * t;
    s.y = m.from.y + (m.to.y - m.from.y) * t;
    s.z = m.from.z + (m.to.z - m.from.z) * t;
    m.place(s);
  }
}

/**
 * How often moving markers are stepped, from how many metres a pixel covers at the camera and
 * how fast the fastest marker moves (default a low orbit, ~7.5 km/s): often enough that it
 * moves at most half a pixel a step, but never more than 30 times a second nor less than once
 * every two seconds. The whole globe in view, where a satellite crosses a pixel in several
 * seconds, costs a step every two seconds; aircraft alone (~250 m/s) are stepped 30 times as
 * seldom as satellites at the same zoom.
 */
export function motionStepMs(metresPerPixel: number, speedMps = 7500): number {
  if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0) return 1000 / 30;
  const speed = Number.isFinite(speedMps) && speedMps > 0 ? speedMps : 7500;
  return Math.max(1000 / 30, Math.min(2000, (0.5 * metresPerPixel * 1000) / speed));
}
