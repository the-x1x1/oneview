import { altitudeToZoom, zoomToAltitudeM, type ViewState } from '@worldview/render-core';
import type { GeoBounds, GeoPosition } from '@worldview/world-model';

/**
 * ViewState ↔ Cesium camera, as pure conversions on plain numbers. The renderer
 * feeds `camera.positionCartographic` (radians) / `camera.heading|pitch`
 * (radians) / `computeViewRectangle()` in and turns the output into
 * `Cartesian3.fromDegrees` + `HeadingPitchRoll` radians.
 */
const DEG = Math.PI / 180;

export interface CameraSample {
  /** Radians. */
  longitude: number;
  latitude: number;
  /** Metres above the ellipsoid. */
  height: number;
  /** Radians, clockwise from north. */
  heading: number;
  /** Radians; −π/2 looks straight down. */
  pitch: number;
  /** Radians; from `camera.computeViewRectangle()` when the globe fills the view. */
  rectangle?: { west: number; south: number; east: number; north: number };
}

export interface CameraTarget {
  longitude: number;
  latitude: number;
  height: number;
  /** Radians. */
  heading: number;
  pitch: number;
  roll: number;
}

export function normalizeHeadingDegrees(h: number): number {
  const x = h % 360;
  return x < 0 ? x + 360 : x;
}

export function cameraToViewState(sample: CameraSample): ViewState {
  const latitude = sample.latitude / DEG;
  const longitude = sample.longitude / DEG;
  const altitudeM = Math.max(1, sample.height);
  const view: ViewState = {
    center: { latitude, longitude },
    altitudeM,
    zoom: altitudeToZoom(altitudeM, latitude),
    headingDegrees: normalizeHeadingDegrees(sample.heading / DEG),
    pitchDegrees: Math.max(-90, Math.min(90, sample.pitch / DEG)),
  };
  if (sample.rectangle) view.bounds = rectangleToBounds(sample.rectangle);
  return view;
}

export function rectangleToBounds(r: { west: number; south: number; east: number; north: number }): GeoBounds {
  return { west: r.west / DEG, south: r.south / DEG, east: r.east / DEG, north: r.north / DEG };
}

/** Merge a partial ViewState onto the current one; zoom fills altitude and vice versa. */
export function viewStateToCamera(partial: Partial<ViewState>, current: ViewState): CameraTarget {
  const center = partial.center ?? current.center;
  let altitudeM: number;
  if (partial.altitudeM !== undefined) altitudeM = partial.altitudeM;
  else if (partial.zoom !== undefined) altitudeM = zoomToAltitudeM(partial.zoom, center.latitude);
  else altitudeM = current.altitudeM;
  const headingDegrees = partial.headingDegrees ?? current.headingDegrees;
  const pitchDegrees = partial.pitchDegrees ?? current.pitchDegrees;
  return {
    longitude: center.longitude,
    latitude: center.latitude,
    height: Math.max(1, altitudeM),
    heading: normalizeHeadingDegrees(headingDegrees) * DEG,
    pitch: Math.max(-90, Math.min(89, pitchDegrees)) * DEG,
    roll: 0,
  };
}

/** Camera altitude that frames `bounds` in a ~60° FOV viewport (aspect ignored, square worst case). */
export function altitudeForBounds(bounds: GeoBounds, minAltitudeM = 500): number {
  const latSpanM = Math.abs(bounds.north - bounds.south) * 111_320;
  const midLat = (bounds.north + bounds.south) / 2;
  const lonSpan = bounds.west <= bounds.east ? bounds.east - bounds.west : 360 - bounds.west + bounds.east;
  const lonSpanM = lonSpan * 111_320 * Math.cos(midLat * DEG);
  const halfSpan = Math.max(latSpanM, lonSpanM) / 2;
  return Math.max(minAltitudeM, (halfSpan / Math.tan(Math.PI / 6)) * 1.15);
}

export type FlyDestination =
  { kind: 'point'; longitude: number; latitude: number; height: number } | { kind: 'bounds'; bounds: GeoBounds };

export function resolveFlyTarget(
  target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
  current: ViewState,
): FlyDestination {
  if (target.bounds) return { kind: 'bounds', bounds: target.bounds };
  const height =
    target.altitudeM ??
    (target.zoom !== undefined
      ? zoomToAltitudeM(target.zoom, target.position.latitude)
      : Math.min(current.altitudeM, 50_000));
  return {
    kind: 'point',
    longitude: target.position.longitude,
    latitude: target.position.latitude,
    height: Math.max(1, height),
  };
}
