import { motionFraction, type CameraModeState, type RenderFeature } from '@worldview/render-core';
import type { Cartesian3Like, CesiumLike, HeadingPitchRangeLike, ViewerLike } from './cesium-like.js';

/** One turn in 90 s: slow enough to read labels as they pass, fast enough to see it move. */
export const ORBIT_DEGREES_PER_SECOND = 4;
/** A tick after a long gap (a hidden window, a suspended renderer) turns by at most this much time. */
const MAX_ORBIT_STEP_S = 0.1;
/** Where follow looks from when it starts: tilted, not straight down, as a flight to a selection does. */
export const FOLLOW_PITCH_DEGREES = -35;

const DEG = Math.PI / 180;

export interface CameraModeHost {
  cesium: Pick<
    CesiumLike,
    'Cartesian2' | 'Cartesian3' | 'HeadingPitchRange' | 'Matrix4' | 'createBoundingSphere' | 'Math'
  >;
  viewer: ViewerLike;
  /** Monotonic milliseconds (the frame clock). */
  now(): number;
  /** Wall-clock epoch milliseconds: what `RenderFeature.motion` is in. */
  wallNow(): number;
  /** The feature as the renderer holds it now. */
  feature(id: string): RenderFeature | undefined;
  /** A mode ended (or changed) without being asked to: the operator dragged, the object went. */
  changed(state: CameraModeState): void;
}

/**
 * Where a follow starts from: close enough to see the object and what is round it. An
 * aircraft at 10 km is watched from ~20 km, a ship from 20 km, a satellite in low orbit from
 * twice its height; never farther than the camera already is.
 */
export function followRange(targetHeightM: number, currentDistanceM: number): number {
  const wanted = Math.max(20_000, Math.max(0, targetHeightM) * 2);
  return Number.isFinite(currentDistanceM) && currentDistanceM > 0 ? Math.min(wanted, currentDistanceM) : wanted;
}

/** Orbit's pitch: the camera's own, kept off the vertical (a spin in place) and off the horizon. */
export function orbitPitch(cameraPitch: number): number {
  return Math.max(-89 * DEG, Math.min(-10 * DEG, cameraPitch));
}

/**
 * Where a point feature is drawn now: at its report, or — with motion — along the chord
 * between its two ends by wall-clock time, the same formula layers/motion.ts places its
 * marker with, so the camera and the marker agree.
 */
export function featurePosition(
  cesium: Pick<CesiumLike, 'Cartesian3'>,
  feature: RenderFeature,
  wallNowMs: number,
): Cartesian3Like | undefined {
  const g = feature.geometry;
  if (g.kind !== 'point') return undefined;
  const p = g.position;
  // Never below the ground: an earthquake's position carries its depth.
  const from = cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, Math.max(0, p.altitudeM ?? 0));
  const m = feature.motion;
  if (!m) return from;
  const to = cesium.Cartesian3.fromDegrees(m.to.longitude, m.to.latitude, m.to.altitudeM ?? p.altitudeM ?? 0);
  const t = motionFraction(m, wallNowMs);
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
}

interface Orbit {
  target: Cartesian3Like;
  heading: number;
  pitch: number;
  range: number;
  lastAt: number;
}

/**
 * The globe's automatic camera modes: orbit (turn slowly round the middle of the view) and
 * follow (keep a moving object in the middle of the view).
 *
 * Both work through Cesium's `lookAt`, which fixes the camera's reference frame at a target:
 * the camera controller then turns round that target, not round the Earth's centre. Ending
 * either mode puts the frame back (`lookAtTransform(IDENTITY)`), which leaves the camera
 * exactly where it is, ready for ordinary panning.
 *
 * Frames. Orbit changes the camera every frame, so it asks for one on every tick of the
 * render loop while it runs — and only then. Follow asks for none of its own: the object it
 * follows moves only when the motion step moves it, and that step already asks for frames at
 * the rate the zoom makes a step visible (renderer.ts); the camera goes along in the same
 * frame. A still object costs nothing.
 */
export class CameraModes3D {
  private orbit: Orbit | undefined;
  private followId: string | null = null;
  /** Following, and the flight there is over: the lookAt frame is set and tracks the object. */
  private engaged = false;
  private lastTarget: Cartesian3Like | undefined;
  private flightToken = 0;

  constructor(private readonly host: CameraModeHost) {}

  get state(): CameraModeState {
    return { orbit: this.orbit !== undefined, follow: this.followId };
  }

  get orbiting(): boolean {
    return this.orbit !== undefined;
  }

  setOrbit(on: boolean): void {
    if (on === this.orbiting) return;
    if (!on) {
      this.orbit = undefined;
      this.release();
      return;
    }
    const hadFollow = this.followId !== null;
    this.endFollow();
    const { viewer, cesium } = this.host;
    const camera = viewer.camera;
    const target = this.viewCentre();
    const range = cesium.Cartesian3.distance(camera.positionWC, target);
    this.orbit = { target, heading: camera.heading, pitch: orbitPitch(camera.pitch), range, lastAt: this.host.now() };
    viewer.scene.requestRender();
    if (hadFollow) this.host.changed(this.state);
  }

  /** Start following a feature (or stop, with null). False when there is nothing to follow. */
  follow(featureId: string | null, opts: { durationMs?: number } = {}): boolean {
    if (featureId === this.followId) return true;
    if (featureId === null) {
      this.endFollow();
      return true;
    }
    const feature = this.host.feature(featureId);
    const target = feature ? featurePosition(this.host.cesium, feature, this.host.wallNow()) : undefined;
    if (!target) {
      if (this.followId !== null) {
        this.endFollow();
        this.host.changed(this.state);
      }
      return false;
    }
    const hadOrbit = this.orbiting;
    this.orbit = undefined;
    this.release();
    this.followId = featureId;
    this.engaged = false;
    this.lastTarget = undefined;
    const { viewer, cesium } = this.host;
    const camera = viewer.camera;
    const height = feature?.geometry.kind === 'point' ? Math.max(0, feature.geometry.position.altitudeM ?? 0) : 0;
    const offset = new cesium.HeadingPitchRange(
      camera.heading,
      FOLLOW_PITCH_DEGREES * DEG,
      followRange(height, cesium.Cartesian3.distance(camera.positionWC, target)),
    );
    const token = ++this.flightToken;
    const engage = () => {
      if (token !== this.flightToken || this.followId !== featureId) return;
      this.engaged = true;
      this.track(offset);
    };
    camera.flyToBoundingSphere(cesium.createBoundingSphere(target, 0), {
      offset,
      duration: (opts.durationMs ?? 1200) / 1000,
      complete: engage,
      // A flight cut short (the operator grabbed the globe) still ends following the object.
      cancel: engage,
    });
    if (hadOrbit) this.host.changed(this.state);
    return true;
  }

  /**
   * The feature being followed changed or went. Called after every renderer update: a
   * followed object that is no longer there ends the follow; one that moved (a new report)
   * is caught up with on the next frame.
   */
  featuresChanged(): void {
    if (this.followId === null) return;
    if (!this.host.feature(this.followId)) {
      this.endFollow();
      this.host.changed(this.state);
      return;
    }
    if (this.engaged) this.host.viewer.scene.requestRender();
  }

  /** Every tick of the render loop, drawn or not (scene.preUpdate): orbit turns and asks for the frame. */
  tick(): void {
    const o = this.orbit;
    if (!o) return;
    const t = this.host.now();
    const dt = Math.max(0, Math.min(MAX_ORBIT_STEP_S, (t - o.lastAt) / 1000));
    o.lastAt = t;
    o.heading = (o.heading + ORBIT_DEGREES_PER_SECOND * DEG * dt) % (2 * Math.PI);
    this.host.viewer.camera.lookAt(o.target, new this.host.cesium.HeadingPitchRange(o.heading, o.pitch, o.range));
    this.host.viewer.scene.requestRender();
  }

  /** Before each drawn frame, after moving markers were stepped (scene.preRender): follow moves along. */
  beforeRender(): void {
    if (this.followId === null || !this.engaged) return;
    this.track();
  }

  /** The operator took hold of the camera (pointer down, wheel, pinch): orbit stops, follow does not. */
  userInput(): void {
    if (!this.orbiting) return;
    this.orbit = undefined;
    this.release();
    this.host.changed(this.state);
  }

  /** Something else moves the camera now (a flight, a new view): both modes end. */
  cancelAll(): void {
    const before = this.state;
    this.orbit = undefined;
    this.endFollow();
    this.release();
    if (before.orbit || before.follow !== null) this.host.changed(this.state);
  }

  dispose(): void {
    this.orbit = undefined;
    this.followId = null;
    this.engaged = false;
  }

  /** Put the lookAt frame on the followed object where it is now, keeping the camera's offset from it. */
  private track(initial?: HeadingPitchRangeLike): void {
    const id = this.followId;
    const feature = id ? this.host.feature(id) : undefined;
    const target = feature ? featurePosition(this.host.cesium, feature, this.host.wallNow()) : undefined;
    if (!target) return;
    const last = this.lastTarget;
    if (!initial && last && last.x === target.x && last.y === target.y && last.z === target.z) return;
    this.lastTarget = target;
    const camera = this.host.viewer.camera;
    // Once locked, camera.position is the offset in the object's local frame: whatever the
    // operator has turned or zoomed to is kept as the object moves on.
    camera.lookAt(target, initial ?? this.host.cesium.Cartesian3.clone(camera.position));
  }

  private endFollow(): void {
    if (this.followId === null) return;
    this.followId = null;
    this.engaged = false;
    this.lastTarget = undefined;
    this.flightToken++;
    this.release();
  }

  /** Back to the Earth-fixed frame, camera left where it is. */
  private release(): void {
    this.host.viewer.camera.lookAtTransform(this.host.cesium.Matrix4.IDENTITY);
  }

  /** The ground in the middle of the view, or below the camera when the middle is sky. */
  private viewCentre(): Cartesian3Like {
    const { viewer, cesium } = this.host;
    const canvas = viewer.scene.canvas;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    const hit = viewer.camera.pickEllipsoid(new cesium.Cartesian2(w / 2, h / 2));
    if (hit) return hit;
    const c = viewer.camera.positionCartographic;
    return cesium.Cartesian3.fromDegrees(cesium.Math.toDegrees(c.longitude), cesium.Math.toDegrees(c.latitude), 0);
  }
}
