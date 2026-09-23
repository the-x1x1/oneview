import { altitudeToZoom, zoomToAltitudeM, type ViewState } from '@worldview/render-core';
import { clampBounds, type GeoBounds, type GeoPosition } from '@worldview/world-model';

/**
 * ViewState ↔ MapLibre camera. Pitch: the contract uses −90 for straight down
 * (Cesium convention); MapLibre uses 0 for top-down and up to 85 tilted.
 * Bearing and heading share the sense (degrees clockwise from north).
 */
export const MAX_MAPLIBRE_PITCH = 85;

export function pitchDegreesToMapLibre(pitchDegrees: number): number {
  return Math.max(0, Math.min(MAX_MAPLIBRE_PITCH, pitchDegrees + 90));
}
export function mapLibrePitchToDegrees(pitch: number): number {
  return pitch - 90;
}
export function normalizeBearing(b: number): number {
  const x = b % 360;
  return x < 0 ? x + 360 : x;
}

export interface MapCameraSample {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
  bounds?: GeoBounds;
  /** The map's larger dimension in CSS pixels (render-core `zoomToAltitudeM`). */
  viewportPx?: number;
}

export function mapToViewState(s: MapCameraSample): ViewState {
  const view: ViewState = {
    center: { latitude: s.lat, longitude: s.lng },
    zoom: s.zoom,
    altitudeM: zoomToAltitudeM(s.zoom, s.lat, s.viewportPx),
    headingDegrees: normalizeBearing(s.bearing),
    pitchDegrees: mapLibrePitchToDegrees(s.pitch),
  };
  // MapLibre reports an unwrapped longitude once the map has been dragged past the
  // antimeridian, and a viewport outside ±180 is refused by the IPC contract.
  if (s.bounds) view.bounds = clampBounds(s.bounds);
  return view;
}

export interface MapCameraTarget {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

export function viewStateToMap(partial: Partial<ViewState>, current: ViewState, viewportPx?: number): MapCameraTarget {
  const center = partial.center ?? current.center;
  let zoom: number;
  if (partial.zoom !== undefined) zoom = partial.zoom;
  else if (partial.altitudeM !== undefined) zoom = altitudeToZoom(partial.altitudeM, center.latitude, viewportPx);
  else zoom = current.zoom;
  return {
    center: [center.longitude, center.latitude],
    zoom: Math.max(0, Math.min(22, zoom)),
    bearing: normalizeBearing(partial.headingDegrees ?? current.headingDegrees),
    pitch: pitchDegreesToMapLibre(partial.pitchDegrees ?? current.pitchDegrees),
  };
}

export type MapFlyTarget =
  | { kind: 'bounds'; bounds: [number, number, number, number] }
  | { kind: 'center'; center: [number, number]; zoom: number };

export function resolveMapFlyTarget(
  target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
  current: ViewState,
  viewportPx?: number,
): MapFlyTarget {
  if (target.bounds)
    return {
      kind: 'bounds',
      bounds: [target.bounds.west, target.bounds.south, target.bounds.east, target.bounds.north],
    };
  const zoom =
    target.zoom ??
    (target.altitudeM !== undefined
      ? altitudeToZoom(target.altitudeM, target.position.latitude, viewportPx)
      : Math.max(current.zoom, 10));
  return {
    kind: 'center',
    center: [target.position.longitude, target.position.latitude],
    zoom: Math.max(0, Math.min(22, zoom)),
  };
}
