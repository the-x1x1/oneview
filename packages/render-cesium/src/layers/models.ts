import { motionFraction, positionAlong, type RenderFeature, type RenderMotion } from '@worldview/render-core';
import type { GeoPosition } from '@worldview/world-model';
import type {
  CartographicLike,
  Cartesian3Like,
  CesiumLike,
  ColorLike,
  CreditDisplayLike,
  CreditLike,
  ModelLike,
  PrimitiveGroupLike,
  SceneLike,
} from '../cesium-like.js';
import { escapeHtml } from '../attribution.js';
import { heightFor } from '../geometry.js';
import type { Movers } from './motion.js';

/**
 * Aircraft and ships as 3D models when the camera is close in — the nearest few dozen, within
 * a few tens of kilometres — with everything else, and the modelled objects until their model
 * is ready, left as the billboards they always were. Adapted from God's Eye View's glTF model
 * regime (src/layers/military/rendering.js and policy.js, src/data/aircraftClass.js
 * `CLASS_MODEL_REAL`, MIT): a hard cap on how many are drawn, nearest first, only below an
 * altitude ceiling, with the models GEV prepared (CC BY 4.0, credited on screen while drawn).
 *
 * The budget is the Radeon 740M's. Every model is a draw call of its own and a pass through
 * Cesium's PBR shader, and none is instanced, so the count is capped (`MODEL_CAP`) however
 * many aircraft are near. Each kind's file is fetched once: Cesium keeps loaded glTF
 * resources in its resource cache by URL, so a second 787 shares the first one's geometry and
 * textures, and a model released by one aircraft is kept, hidden, for the next of its kind.
 * None of the files is Draco-compressed (checked: no `KHR_draco_mesh_compression` in any of
 * them), so a model costs no decoder worker and no wasm.
 *
 * Nothing here asks for a frame of its own. Models are chosen in the frame being drawn
 * (renderer.ts calls `update` from preRender) and moved with the markers' dead reckoning
 * (motion.ts `Movers`), which already requests exactly the frames motion needs; a model that
 * finishes loading asks for one frame, to be seen.
 */

/** Which model an object is drawn with. */
export type ModelKind =
  'airliner' | 'widebody' | 'turboprop' | 'light' | 'helicopter' | 'business' | 'uav' | 'fast-jet' | 'ship';

export interface ModelCredit {
  title: string;
  author: string;
  authorUrl: string;
  sourceUrl: string;
}

export interface ModelAsset {
  /** File name under the models directory (apps/desktop/assets/models). */
  file: string;
  /** Scale applied to the file's own size (the aircraft files are in metres already). */
  scale: number;
  /**
   * Where the nose or bow points in the model's frame, after Cesium turns glTF's +Y up into
   * +Z up ((x, y, z) → (x, −z, y)): the aircraft are nose −X (GEV's convention), the ship's
   * bow is glTF +Z, so −Y.
   */
  forward: '-x' | '-y';
  /**
   * How far above the object's reported position the model's origin (its bounding-box
   * centre) goes, metres, after scale: an aircraft's belly (half its height) so one on the
   * ground stands on it, a ship's waterline.
   */
  liftM: number;
  /**
   * The length, metres, `scale` draws the model at — for a model that can be drawn at an
   * object's own length (`RenderStyle.lengthM`) instead: the ship.
   */
  lengthM?: number;
  /** Smallest size on screen, pixels: about the billboard's, so the hand-over is not a jump. */
  minimumPixelSize: number;
  credit: ModelCredit;
}

const CC_BY_4 = 'https://creativecommons.org/licenses/by/4.0/';

/**
 * The bundled models. Sizes were read from each file's bounding box (the aircraft files are
 * transform-baked, metre-scaled and centred, per GEV's models README); a scale other than 1 is
 * the one place a model stands in for a type of a different size: the 747 file for every
 * narrow-body jet (37 m, an A320's length), the private jet for a fighter (18 m), and the
 * cargo ship at 120 m — AIS gives a vessel's length only for some, and presentation does not
 * pass it on.
 */
export const MODEL_ASSETS: Readonly<Record<ModelKind, ModelAsset>> = Object.freeze({
  airliner: {
    file: 'airplane.glb',
    scale: 0.72,
    forward: '-x',
    liftM: 6.72 * 0.72,
    minimumPixelSize: 32,
    credit: {
      title: 'boeing 747',
      author: 'zairiq-123',
      authorUrl: 'https://sketchfab.com/zairiq-123',
      sourceUrl: 'https://sketchfab.com/3d-models/boeing-747-9b16672038ba48f98e6d80a159044ed9',
    },
  },
  widebody: {
    file: 'b789.glb',
    scale: 1,
    forward: '-x',
    liftM: 7.81,
    minimumPixelSize: 36,
    credit: {
      title: 'Boeing 787-9',
      author: 'Nobilis 2',
      authorUrl: 'https://sketchfab.com/nobilishornet2',
      sourceUrl: 'https://sketchfab.com/3d-models/boeing-787-9-b6711e2e698e4e469675c1154a50b7a3',
    },
  },
  turboprop: {
    file: 'atr72.glb',
    scale: 1,
    forward: '-x',
    liftM: 3.81,
    minimumPixelSize: 30,
    credit: {
      title: 'ATR 72 - 600',
      author: 'Oyan3D',
      authorUrl: 'https://sketchfab.com/oyan3D',
      sourceUrl: 'https://sketchfab.com/3d-models/atr-72-600-1e1a7186f7444d288675262fcee44744',
    },
  },
  light: {
    file: 'c172.glb',
    scale: 1,
    forward: '-x',
    liftM: 1.36,
    minimumPixelSize: 24,
    credit: {
      title: 'Cessna 172',
      author: 'e737',
      authorUrl: 'https://sketchfab.com/e0057537',
      sourceUrl: 'https://sketchfab.com/3d-models/cessna-172-64cddaee5aff470682659a8c08525046',
    },
  },
  helicopter: {
    file: 'bell206.glb',
    scale: 1,
    forward: '-x',
    liftM: 1.66,
    minimumPixelSize: 26,
    credit: {
      title: 'Bell 206 JetRanger',
      author: 'terran4627',
      authorUrl: 'https://sketchfab.com/terran4627',
      sourceUrl: 'https://sketchfab.com/3d-models/bell-206-jetranger-d2f7ba1d671549d4b26aaf834139a1dd',
    },
  },
  business: {
    file: 'citation2.glb',
    scale: 1,
    forward: '-x',
    liftM: 2.86,
    minimumPixelSize: 28,
    credit: {
      title: '1990 Cessna Citation, Texture Detailed, Exterior',
      author: 'BlenderCommunityHead',
      authorUrl: 'https://sketchfab.com/aboodgoudagad',
      sourceUrl:
        'https://sketchfab.com/3d-models/1990-cessna-citation-texture-detailed-exterior-a78839624fe64900a8352cb23462350a',
    },
  },
  uav: {
    file: 'mq9.glb',
    scale: 1,
    forward: '-x',
    liftM: 2.02,
    minimumPixelSize: 26,
    credit: {
      title: 'MQ-9',
      author: 'IProZenoN',
      authorUrl: 'https://sketchfab.com/IProZenoN',
      sourceUrl: 'https://sketchfab.com/3d-models/mq-9-fabe963feb354c5584b51f9c470c3f7e',
    },
  },
  'fast-jet': {
    file: 'jet.glb',
    scale: 0.42,
    forward: '-x',
    liftM: 5.63 * 0.42,
    minimumPixelSize: 28,
    credit: {
      title: 'Private Jet',
      author: 'Nick the Name',
      authorUrl: 'https://sketchfab.com/Nick_The_Name',
      sourceUrl: 'https://sketchfab.com/3d-models/private-jet-cbdd1de6ced9461e950eafaa302cc82b',
    },
  },
  ship: {
    // 4,200 file units long (after its node transforms): 120 m at this scale. The bow is the
    // end away from the superstructure (glTF +Z), read from the geometry: the tallest tenth
    // of its vertices sit at the other end.
    file: 'ship.glb',
    scale: 120 / 4200,
    forward: '-y',
    liftM: 9,
    lengthM: 120,
    minimumPixelSize: 36,
    credit: {
      title: 'Low Poly Cargo Ship',
      author: 'Javier_Fernandez',
      authorUrl: 'https://sketchfab.com/Javier.Fernandez',
      sourceUrl: 'https://sketchfab.com/3d-models/low-poly-cargo-ship-4c22cbaf01c1427f8ab60b3a07b1b32c',
    },
  },
});

/**
 * Model per marker icon (render-core icons.ts, aircraft-class.ts). The icon is the class the
 * shell already chose for the object, so no second classification runs here. A glider or a
 * balloon has no model; the unknown class draws the generic jet icon, and so the airliner.
 */
export const ICON_MODEL: Readonly<Record<string, ModelKind>> = Object.freeze({
  aircraft: 'airliner',
  'aircraft-business': 'business',
  'aircraft-heavy': 'widebody',
  'aircraft-turboprop': 'turboprop',
  'aircraft-light': 'light',
  helicopter: 'helicopter',
  'aircraft-fastjet': 'fast-jet',
  uav: 'uav',
  vessel: 'ship',
});

/** At most this many models at once (GEV's proximity mode allows 150; this machine is not that). */
export const MODEL_CAP = 24;
/** Camera altitude above which no model is drawn: from higher, a 60-m aircraft is a few pixels. */
export const MODEL_CEILING_M = 50_000;
/** An object is given a model within this distance of the camera… */
export const MODEL_RANGE_M = 30_000;
/** …and keeps it out to this one, so one near the edge does not swap every frame. */
export const MODEL_KEEP_M = 36_000;
/**
 * How often the nearest are chosen again while things move (the camera moving re-chooses in
 * the frame it moved: in request-render mode the last frame of a drag may be the last frame
 * for a while, so a choice put off would stay stale).
 */
export const MODEL_RECHOOSE_MS = 1000;
/**
 * How far (degrees) an object may be from where it was reported and still be carried there by
 * its dead reckoning (MOTION_MAX_T spans of a fast aircraft's poll): the margin of the first,
 * cheap box around the camera, tested on the reported position before the carried one is
 * worked out.
 */
const DRIFT_MARGIN_DEG = 0.15;

/**
 * The asset drawn at an object's own length where it has one and the asset can be (a ship at
 * its AIS length, its waterline lift with it); otherwise the asset as it is.
 */
export function sizedAsset(asset: ModelAsset, lengthM: number | undefined): ModelAsset {
  if (!asset.lengthM || lengthM === undefined || !Number.isFinite(lengthM) || lengthM <= 0) return asset;
  const k = lengthM / asset.lengthM;
  return { ...asset, scale: asset.scale * k, liftM: asset.liftM * k, lengthM };
}

/** The model an icon feature is drawn with, or undefined for none. */
export function modelKindFor(feature: RenderFeature): ModelKind | undefined {
  if (feature.geometry.kind !== 'point' || !feature.style.icon) return undefined;
  return ICON_MODEL[feature.style.icon];
}

/**
 * Which of the candidates get a model: those within `rangeM` (those already modelled within
 * `keepM`), nearest first, at most `cap`. A modelled one counts as a tenth nearer than it is,
 * so two at nearly the same distance do not trade the last slot back and forth.
 */
export function chooseModelled(
  candidates: ReadonlyArray<{ id: string; distanceM: number }>,
  current: ReadonlySet<string>,
  cap: number = MODEL_CAP,
  rangeM: number = MODEL_RANGE_M,
  keepM: number = MODEL_KEEP_M,
): string[] {
  const eligible: Array<{ id: string; rank: number }> = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.distanceM)) continue;
    const held = current.has(c.id);
    if (c.distanceM > (held ? keepM : rangeM)) continue;
    eligible.push({ id: c.id, rank: held ? c.distanceM * 0.9 : c.distanceM });
  }
  eligible.sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return eligible.slice(0, Math.max(0, cap)).map((e) => e.id);
}

const DEG = Math.PI / 180;
const EARTH_RADIUS_M = 6_371_008.8;
const WGS84_A = 6_378_137;
const WGS84_E2 = 6.69437999014e-3;

/** Straight-line distance (m) between two geographic points with heights: haversine across, height up. */
export function distanceM(
  a: { latitude: number; longitude: number; heightM: number },
  b: { latitude: number; longitude: number; heightM: number },
): number {
  const φ1 = a.latitude * DEG;
  const φ2 = b.latitude * DEG;
  const dφ = φ2 - φ1;
  const dλ = (b.longitude - a.longitude) * DEG;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const ground = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.hypot(ground, b.heightM - a.heightM);
}

/** Initial bearing (degrees clockwise from north) from `a` to `b`. */
export function bearingDegrees(a: GeoPosition, b: GeoPosition): number {
  const φ1 = a.latitude * DEG;
  const φ2 = b.latitude * DEG;
  const dλ = (b.longitude - a.longitude) * DEG;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
}

/** The steepest climb or descent a model is drawn at, degrees: past it the reported altitudes are noise. */
export const MAX_PITCH_DEG = 20;

/**
 * Heading and pitch a feature's model is drawn at: the heading the marker shows
 * (`rotationDegrees`, the reported track), else the direction of its move; the pitch from the
 * move's climb over its ground distance — an aircraft whose altitude and next altitude were
 * both reported — else level. A ship is always level.
 */
export function attitudeFor(feature: RenderFeature, kind: ModelKind): { headingDeg: number; pitchDeg: number } {
  const g = feature.geometry;
  const from = g.kind === 'point' ? g.position : undefined;
  const m = feature.motion;
  let headingDeg = feature.style.rotationDegrees;
  let pitchDeg = 0;
  if (from && m) {
    const ground = distanceM(
      { latitude: from.latitude, longitude: from.longitude, heightM: 0 },
      { latitude: m.to.latitude, longitude: m.to.longitude, heightM: 0 },
    );
    if (headingDeg === undefined && ground > 1) headingDeg = bearingDegrees(from, m.to);
    if (kind !== 'ship' && from.altitudeM !== undefined && m.to.altitudeM !== undefined && ground > 1) {
      const climb = Math.atan2(m.to.altitudeM - from.altitudeM, ground) / DEG;
      pitchDeg = Math.max(-MAX_PITCH_DEG, Math.min(MAX_PITCH_DEG, climb));
    }
  }
  return { headingDeg: Number.isFinite(headingDeg) ? (headingDeg as number) : 0, pitchDeg };
}

/**
 * The model's transform (16 values, column-major, as Cesium's Matrix4 stores them) for an
 * asset at a geodetic position and attitude: the model frame's forward axis along the heading
 * tilted up by the pitch, its +Z along the tilted up, uniformly scaled, its origin at the
 * position on the WGS84 ellipsoid. Computed here rather than with Cesium's
 * `headingPitchRollToFixedFrame` so the convention is written down once and tested, whatever
 * way round a file's nose points.
 */
export function modelMatrixValues(
  latitudeDeg: number,
  longitudeDeg: number,
  heightM: number,
  headingDeg: number,
  pitchDeg: number,
  asset: Pick<ModelAsset, 'scale' | 'forward'>,
  out: number[] = new Array<number>(16),
): number[] {
  const φ = latitudeDeg * DEG;
  const λ = longitudeDeg * DEG;
  const sφ = Math.sin(φ);
  const cφ = Math.cos(φ);
  const sλ = Math.sin(λ);
  const cλ = Math.cos(λ);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sφ * sφ);
  // Local east, north, up at the position.
  const e = [-sλ, cλ, 0];
  const no = [-sφ * cλ, -sφ * sλ, cφ];
  const up = [cφ * cλ, cφ * sλ, sφ];
  const ψ = headingDeg * DEG;
  const θ = pitchDeg * DEG;
  // Level direction of travel, then tilted by the pitch; the model's up tilts with it.
  const d = [0, 1, 2].map((i) => no[i]! * Math.cos(ψ) + e[i]! * Math.sin(ψ));
  const f = [0, 1, 2].map((i) => d[i]! * Math.cos(θ) + up[i]! * Math.sin(θ));
  const u = [0, 1, 2].map((i) => -d[i]! * Math.sin(θ) + up[i]! * Math.cos(θ));
  // f × u: to the right of the direction of travel.
  const r = [f[1]! * u[2]! - f[2]! * u[1]!, f[2]! * u[0]! - f[0]! * u[2]!, f[0]! * u[1]! - f[1]! * u[0]!];
  // Model axes → world. Nose −X: +X is aft, +Y to the right. Bow −Y: +Y is aft, +X to the left.
  let x: number[];
  let y: number[];
  if (asset.forward === '-x') {
    x = f.map((v) => -v);
    y = r;
  } else {
    x = r.map((v) => -v);
    y = f.map((v) => -v);
  }
  const s = asset.scale;
  out[0] = x[0]! * s;
  out[1] = x[1]! * s;
  out[2] = x[2]! * s;
  out[3] = 0;
  out[4] = y[0]! * s;
  out[5] = y[1]! * s;
  out[6] = y[2]! * s;
  out[7] = 0;
  out[8] = u[0]! * s;
  out[9] = u[1]! * s;
  out[10] = u[2]! * s;
  out[11] = 0;
  out[12] = (n + heightM) * cφ * cλ;
  out[13] = (n + heightM) * cφ * sλ;
  out[14] = (n * (1 - WGS84_E2) + heightM) * sφ;
  out[15] = 1;
  return out;
}

/** Where a feature is now: its position carried along its move to `nowMs` (render-core motion.ts). */
export function positionNow(feature: RenderFeature, nowMs: number): GeoPosition | undefined {
  const g = feature.geometry;
  if (g.kind !== 'point') return undefined;
  const m = feature.motion;
  if (!m) return g.position;
  const [longitude, latitude] = positionAlong(g.position, m, nowMs);
  const a = g.position.altitudeM;
  const b = m.to.altitudeM;
  const altitudeM = a !== undefined && b !== undefined ? a + (b - a) * motionFraction(m, nowMs) : a;
  return altitudeM !== undefined ? { latitude, longitude, altitudeM } : { latitude, longitude };
}

/** The on-screen credit for one model: title, author, licence, and that it was modified. */
export function modelCreditHtml(c: ModelCredit): string {
  return (
    `3D model <a href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener">“${escapeHtml(c.title)}”</a>` +
    ` by <a href="${escapeHtml(c.authorUrl)}" target="_blank" rel="noopener">${escapeHtml(c.author)}</a>,` +
    ` <a href="${CC_BY_4}" target="_blank" rel="noopener">CC BY 4.0</a>, modified`
  );
}

export type ModelLayerModule = Pick<
  CesiumLike,
  'loadModel' | 'createPrimitiveCollection' | 'Matrix4' | 'Cartesian3' | 'Cartographic' | 'HeightReference' | 'Credit'
>;

export interface ModelLayerOptions {
  cesium: ModelLayerModule;
  scene: SceneLike;
  creditDisplay: CreditDisplayLike;
  /** Where the model files are served, ending in `/` (the shell's `./models/`). */
  baseUrl: string;
  /** The markers' dead reckoning, which moves the models too. */
  movers: Movers;
  /** Every feature the renderer holds (the layer set's store). */
  features: () => Iterable<RenderFeature>;
  /** Hide (true) or show again (false) the marker of a feature whose model is drawn. */
  hideMarker: (featureId: string, hidden: boolean) => void;
  /** The outline of a selected object's model. */
  selectedColor: ColorLike;
  /** Wall-clock time (epoch ms), which RenderFeature.motion is in. */
  wallNow: () => number;
  onError?: (message: string) => void;
}

/** One model instance, kept for its kind and handed from one object to the next. */
interface Slot {
  kind: ModelKind;
  model: ModelLike | undefined;
  /** The load failed or the slot was retired: never drawn. */
  dead: boolean;
  featureId: string | null;
  /** The marker of `featureId` is hidden because this model is drawn instead. */
  markerHidden: boolean;
  /** The last transform, applied when the model arrives. */
  matrix: number[];
  heightReference: number;
  selected: boolean;
}

/**
 * The models on the globe. `update` is called before every drawn frame with the camera; it
 * chooses again when the camera has moved, the features have changed or a second has passed,
 * and otherwise returns at once.
 */
export class ModelLayer {
  private readonly group: PrimitiveGroupLike;
  private readonly slots: Slot[] = [];
  private readonly byFeature = new Map<string, Slot>();
  private readonly failed = new Set<ModelKind>();
  private readonly credits = new Map<ModelKind, CreditLike>();
  private enabled = false;
  private dirty = true;
  private lastChoiceAt = Number.NEGATIVE_INFINITY;
  private lastCamera: { latitude: number; longitude: number; heightM: number } | undefined;
  private disposed = false;

  constructor(private readonly o: ModelLayerOptions) {
    this.group = o.scene.primitives.add(o.cesium.createPrimitiveCollection());
  }

  /** Models on or off (the graphics profile's `models3d`). Off releases every object at once. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.dirty = true;
    if (!on) this.releaseAll();
    this.o.scene.requestRender();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Features were added, changed or removed (or one was selected): choose again and refresh the drawn ones. */
  featuresChanged(): void {
    this.dirty = true;
  }

  /** Objects drawn as models now (model ready and shown). */
  get drawn(): string[] {
    return this.slots.filter((s) => s.featureId && s.markerHidden).map((s) => s.featureId!);
  }
  /** Objects given a model, ready or not. */
  get assigned(): string[] {
    return [...this.byFeature.keys()];
  }
  /** Model instances alive (loaded or loading). */
  get instances(): number {
    return this.slots.filter((s) => !s.dead).length;
  }

  /**
   * Before a frame: choose the nearest objects again when it is due. `camera` is the camera's
   * geodetic position. Returns whether anything changed.
   */
  update(camera: CartographicLike, nowMs: number = this.o.wallNow()): boolean {
    if (this.disposed || !this.enabled) return false;
    const cam = { latitude: camera.latitude / DEG, longitude: camera.longitude / DEG, heightM: camera.height };
    const moved =
      !this.lastCamera ||
      distanceM(this.lastCamera, cam) > Math.max(50, 0.02 * Math.min(this.lastCamera.heightM, cam.heightM));
    if (!this.dirty && !moved && nowMs - this.lastChoiceAt < MODEL_RECHOOSE_MS) return false;
    const refresh = this.dirty;
    this.dirty = false;
    this.lastChoiceAt = nowMs;
    this.lastCamera = cam;
    if (cam.heightM > MODEL_CEILING_M) return this.releaseAll();
    const candidates: Array<{ id: string; distanceM: number }> = [];
    const byId = new Map<string, RenderFeature>();
    // A generous box first: most features are nowhere near, and the box costs two compares —
    // on the reported position with room for its drift, then on where it has been carried.
    const dLat = (MODEL_KEEP_M + cam.heightM) / 111_000;
    const dLon = dLat / Math.max(0.05, Math.cos(cam.latitude * DEG));
    const outside = (p: GeoPosition, margin: number) => {
      if (Math.abs(p.latitude - cam.latitude) > dLat + margin) return true;
      let lonGap = Math.abs(p.longitude - cam.longitude);
      if (lonGap > 180) lonGap = 360 - lonGap;
      return lonGap > dLon + margin / Math.max(0.05, Math.cos(cam.latitude * DEG));
    };
    for (const f of this.o.features()) {
      const kind = modelKindFor(f);
      if (!kind || this.failed.has(kind) || f.geometry.kind !== 'point') continue;
      if (outside(f.geometry.position, f.motion ? DRIFT_MARGIN_DEG : 0)) continue;
      const p = positionNow(f, nowMs);
      if (!p || outside(p, 0)) continue;
      const heightM = heightFor(p, f.style.heightMode);
      candidates.push({
        id: f.id,
        distanceM: distanceM(cam, { latitude: p.latitude, longitude: p.longitude, heightM }),
      });
      byId.set(f.id, f);
    }
    const chosen = chooseModelled(candidates, new Set(this.byFeature.keys()));
    const keep = new Set(chosen);
    let changed = false;
    for (const id of [...this.byFeature.keys()])
      if (!keep.has(id)) {
        this.release(id);
        changed = true;
      }
    for (const id of chosen) {
      const f = byId.get(id)!;
      const held = this.byFeature.get(id);
      if (held && held.kind === modelKindFor(f)) {
        if (refresh) this.place(held, f);
        continue;
      }
      if (held) this.release(id);
      this.assign(f);
      changed = true;
    }
    if (changed) this.syncCredits();
    return changed;
  }

  private assign(f: RenderFeature): void {
    const kind = modelKindFor(f)!;
    let slot = this.slots.find((s) => !s.dead && s.featureId === null && s.kind === kind);
    if (!slot) {
      if (this.instances >= MODEL_CAP) {
        // Every instance is spoken for by some kind: retire a free one of another kind.
        const spare = this.slots.find((s) => !s.dead && s.featureId === null);
        if (!spare) return;
        this.retire(spare);
      }
      slot = this.createSlot(kind);
    }
    slot.featureId = f.id;
    this.byFeature.set(f.id, slot);
    this.place(slot, f);
  }

  private createSlot(kind: ModelKind): Slot {
    const asset = MODEL_ASSETS[kind];
    const slot: Slot = {
      kind,
      model: undefined,
      dead: false,
      featureId: null,
      markerHidden: false,
      matrix: new Array<number>(16).fill(0),
      heightReference: this.o.cesium.HeightReference.NONE,
      selected: false,
    };
    this.slots.push(slot);
    this.o.cesium
      .loadModel({
        url: `${this.o.baseUrl}${asset.file}`,
        scene: this.o.scene,
        show: false,
        minimumPixelSize: asset.minimumPixelSize,
        maximumScale: 60,
      })
      .then(
        (model) => {
          if (slot.dead || this.disposed) {
            model.destroy();
            return;
          }
          slot.model = model;
          this.group.add(model);
          model.readyEvent.addEventListener(() => {
            this.apply(slot);
            this.o.scene.requestRender();
          });
          model.errorEvent.addEventListener(() => this.fail(slot));
          this.apply(slot);
          // The model loads over the next frames (Cesium asks for them while it does); this
          // one starts it.
          this.o.scene.requestRender();
        },
        (err: unknown) => this.fail(slot, err),
      );
    return slot;
  }

  /** A model that cannot load: its kind stays a billboard from now on, and it is said once. */
  private fail(slot: Slot, err?: unknown): void {
    if (this.disposed) return;
    const first = !this.failed.has(slot.kind);
    this.failed.add(slot.kind);
    for (const s of this.slots.filter((x) => x.kind === slot.kind)) this.retire(s);
    this.retire(slot);
    if (first) {
      const file = MODEL_ASSETS[slot.kind].file;
      const why = err instanceof Error ? `: ${err.message}` : '';
      this.o.onError?.(`3D model ${file} did not load${why}; those objects stay markers`);
    }
    this.syncCredits();
    this.o.scene.requestRender();
  }

  /** Put a slot's model where its feature is, and keep it moving with the feature. */
  private place(slot: Slot, f: RenderFeature): void {
    const g = f.geometry;
    if (g.kind !== 'point') return;
    const asset = sizedAsset(MODEL_ASSETS[slot.kind], f.style.lengthM);
    const mode = f.style.heightMode;
    // A height above the ellipsoid for an aircraft with an altitude; for the rest (ships, an
    // aircraft on the ground) a height above the terrain, as their markers are clamped.
    slot.heightReference =
      mode === 'absolute' ? this.o.cesium.HeightReference.NONE : this.o.cesium.HeightReference.RELATIVE_TO_GROUND;
    slot.selected = f.style.selected === true;
    const { headingDeg, pitchDeg } = attitudeFor(f, slot.kind);
    const at = (p: GeoPosition) =>
      this.o.cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, heightFor(p, mode) + asset.liftM);
    const put = (c: Cartesian3Like) => {
      const carto = this.o.cesium.Cartographic.fromCartesian(c);
      if (!carto) return;
      modelMatrixValues(
        carto.latitude / DEG,
        carto.longitude / DEG,
        carto.height,
        headingDeg,
        pitchDeg,
        asset,
        slot.matrix,
      );
      this.writeMatrix(slot);
    };
    const key = `m:${f.id}`;
    const m: RenderMotion | undefined = f.motion;
    if (m) {
      this.o.movers.set(
        key,
        { place: put, shown: () => slot.model?.show === true, from: at(g.position), to: at(m.to) },
        m,
      );
    } else {
      this.o.movers.delete(key);
      put(at(g.position));
    }
    this.apply(slot);
  }

  private writeMatrix(slot: Slot): void {
    const model = slot.model;
    if (!model) return;
    model.modelMatrix = this.o.cesium.Matrix4.fromArray(slot.matrix, 0, model.modelMatrix);
  }

  /** Bring a slot's model in line with its state; hide or show the marker it stands in for. */
  private apply(slot: Slot): void {
    const model = slot.model;
    const drawn = !slot.dead && slot.featureId !== null && this.enabled;
    if (model && !model.isDestroyed()) {
      model.show = drawn;
      if (drawn) {
        model.id = slot.featureId;
        if (model.heightReference !== slot.heightReference) model.heightReference = slot.heightReference;
        model.silhouetteSize = slot.selected ? 2 : 0;
        if (slot.selected) model.silhouetteColor = this.o.selectedColor;
        this.writeMatrix(slot);
      }
    }
    const hide = drawn && model?.ready === true;
    if (hide !== slot.markerHidden && slot.featureId) {
      slot.markerHidden = hide;
      this.o.hideMarker(slot.featureId, hide);
      this.syncCredits();
    }
  }

  private release(id: string): void {
    const slot = this.byFeature.get(id);
    if (!slot) return;
    this.byFeature.delete(id);
    this.o.movers.delete(`m:${id}`);
    if (slot.markerHidden) {
      slot.markerHidden = false;
      this.o.hideMarker(id, false);
    }
    slot.featureId = null;
    slot.selected = false;
    this.apply(slot);
  }

  private releaseAll(): boolean {
    const any = this.byFeature.size > 0;
    for (const id of [...this.byFeature.keys()]) this.release(id);
    if (any) this.syncCredits();
    return any;
  }

  /** Destroy a slot's model for good (its kind failed, or the slot is needed for another kind). */
  private retire(slot: Slot): void {
    if (slot.featureId) this.release(slot.featureId);
    slot.dead = true;
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    if (slot.model) {
      this.group.remove(slot.model);
      if (!slot.model.isDestroyed()) slot.model.destroy();
      slot.model = undefined;
    }
  }

  /** One on-screen credit per kind drawn now; none when no model is. */
  private syncCredits(): void {
    const shown = new Set<ModelKind>();
    for (const s of this.slots) if (s.markerHidden) shown.add(s.kind);
    for (const [kind, credit] of this.credits)
      if (!shown.has(kind)) {
        this.o.creditDisplay.removeStaticCredit(credit);
        this.credits.delete(kind);
      }
    for (const kind of shown)
      if (!this.credits.has(kind)) {
        const credit = new this.o.cesium.Credit(modelCreditHtml(MODEL_ASSETS[kind].credit), true);
        this.o.creditDisplay.addStaticCredit(credit);
        this.credits.set(kind, credit);
      }
  }

  dispose(): void {
    if (this.disposed) return;
    this.releaseAll();
    this.disposed = true;
    for (const s of [...this.slots]) this.retire(s);
    for (const credit of this.credits.values()) this.o.creditDisplay.removeStaticCredit(credit);
    this.credits.clear();
    this.o.scene.primitives.remove(this.group);
    if (!this.group.isDestroyed()) this.group.destroy();
  }
}
