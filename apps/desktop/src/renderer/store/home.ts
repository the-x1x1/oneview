import type { HomeSettings, HomeView } from '@worldview/ipc-contract';
import type { ViewState } from '@worldview/render-core';

/**
 * The operator's home view (Settings → Home view, the Home key and Shift+H).
 *
 * It is a place the operator chose from the map — never one WorldView worked out: there is
 * no IP geolocation and no location permission (the session refuses every permission
 * request). The ground in the middle of the view is kept, with the camera's altitude for
 * the globe and the zoom for the 2D map, and the tilt and heading it was seen with: a home
 * set looking along a coast at an angle comes back that way, not from straight above.
 */
export const NO_HOME: HomeSettings = Object.freeze({ view: null, flyOnStart: false }) as HomeSettings;

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** A view pitched less than this below the horizon counts as tilted; steeper is "from above". */
const TILTED_BELOW_DEG = -85;

/** The home view for what is on screen now. */
export function homeFromView(view: ViewState): HomeView {
  const at = view.focus ?? view.center;
  const lon = ((((at.longitude + 180) % 360) + 360) % 360) - 180;
  const home: HomeView = {
    latitude: round(Math.max(-90, Math.min(90, at.latitude)), 6),
    longitude: round(lon, 6),
    altitudeM: Math.round(Math.max(1, Math.min(100_000_000, view.altitudeM))),
    zoom: round(Math.max(0, Math.min(24, view.zoom)), 2),
  };
  const pitch = view.pitchDegrees;
  if (Number.isFinite(pitch) && pitch > TILTED_BELOW_DEG)
    home.pitchDegrees = round(Math.max(-89, Math.min(0, pitch)), 1);
  const heading = ((((view.headingDegrees % 360) + 360) % 360) + 360) % 360;
  if (Number.isFinite(heading) && Math.min(heading, 360 - heading) >= 0.5) home.headingDegrees = round(heading, 1);
  return home;
}

/**
 * What `flyTo` is given to go home. Tilted, the globe arrives at a distance from the ground
 * in the middle of the view along the line of sight, so that distance is the altitude over
 * the sine of the tilt: the camera ends at the height it was set from.
 */
export function homeFlyTarget(home: HomeView): {
  position: { latitude: number; longitude: number };
  altitudeM: number;
  zoom: number;
} {
  const tilt = home.pitchDegrees;
  const range =
    tilt !== undefined && tilt > TILTED_BELOW_DEG
      ? home.altitudeM / Math.max(0.1, Math.sin((-tilt * Math.PI) / 180))
      : home.altitudeM;
  return {
    position: { latitude: home.latitude, longitude: home.longitude },
    altitudeM: Math.round(range),
    zoom: home.zoom,
  };
}

/** The tilt and heading to arrive with: from above, facing north, for a home without them. */
export function homeFlyOptions(home: HomeView): { pitchDegrees?: number; headingDegrees: number } {
  return {
    ...(home.pitchDegrees !== undefined && home.pitchDegrees > TILTED_BELOW_DEG
      ? { pitchDegrees: home.pitchDegrees }
      : {}),
    headingDegrees: home.headingDegrees ?? 0,
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
  const facing = home.headingDegrees !== undefined ? `, facing ${Math.round(home.headingDegrees)}°` : '';
  const tilt =
    home.pitchDegrees !== undefined
      ? ` · tilted ${Math.round(90 + home.pitchDegrees)}°${facing}`
      : facing
        ? ` ·${facing.slice(1)}`
        : '';
  return `${lat}, ${lon} · ${up}${tilt}`;
}

/** Whether to fly home now that the map has drawn: asked for, set, and not done yet this session. */
export function shouldFlyHomeAtStart(
  home: HomeSettings | undefined,
  firstFrame: boolean,
  alreadyFlown: boolean,
): boolean {
  return firstFrame && !alreadyFlown && Boolean(home?.flyOnStart && home.view);
}
