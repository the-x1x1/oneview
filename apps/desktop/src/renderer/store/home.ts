import type { HomeSettings, HomeView } from '@worldview/ipc-contract';
import type { ViewState } from '@worldview/render-core';

/**
 * The operator's home view (Settings → Home view, the Home key and Shift+H).
 *
 * It is a place the operator chose from the map — never one WorldView worked out: there is
 * no IP geolocation and no location permission (the session refuses every permission
 * request). The ground in the middle of the view is kept, with the camera's altitude for
 * the globe and the zoom for the 2D map; returning looks straight down on it.
 */
export const NO_HOME: HomeSettings = Object.freeze({ view: null, flyOnStart: false }) as HomeSettings;

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** The home view for what is on screen now. */
export function homeFromView(view: ViewState): HomeView {
  const at = view.focus ?? view.center;
  const lon = ((((at.longitude + 180) % 360) + 360) % 360) - 180;
  return {
    latitude: round(Math.max(-90, Math.min(90, at.latitude)), 6),
    longitude: round(lon, 6),
    altitudeM: Math.round(Math.max(1, Math.min(100_000_000, view.altitudeM))),
    zoom: round(Math.max(0, Math.min(24, view.zoom)), 2),
  };
}

/** What `flyTo` is given to go home. */
export function homeFlyTarget(home: HomeView): {
  position: { latitude: number; longitude: number };
  altitudeM: number;
  zoom: number;
} {
  return {
    position: { latitude: home.latitude, longitude: home.longitude },
    altitudeM: home.altitudeM,
    zoom: home.zoom,
  };
}

/** "21.3069° N, 157.8583° W · 12 km up", for Settings. */
export function describeHome(home: HomeView): string {
  const lat = `${Math.abs(home.latitude).toFixed(4)}° ${home.latitude >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(home.longitude).toFixed(4)}° ${home.longitude >= 0 ? 'E' : 'W'}`;
  const up =
    home.altitudeM >= 10_000
      ? `${Math.round(home.altitudeM / 1000).toLocaleString('en-US')} km up`
      : `${Math.round(home.altitudeM).toLocaleString('en-US')} m up`;
  return `${lat}, ${lon} · ${up}`;
}

/** Whether to fly home now that the map has drawn: asked for, set, and not done yet this session. */
export function shouldFlyHomeAtStart(
  home: HomeSettings | undefined,
  firstFrame: boolean,
  alreadyFlown: boolean,
): boolean {
  return firstFrame && !alreadyFlown && Boolean(home?.flyOnStart && home.view);
}
