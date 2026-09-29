import type { WorldObject } from '@worldview/world-model';
import { remainingPath, routeProgress, type PresentedRoute } from '@worldview/render-core';
import type { FlightState } from '../store/types.js';

/**
 * What the map draws of the selected aircraft's planned route (presentation.ts
 * `routeFeatures`): the path still to fly, from where the aircraft is now along the great
 * circle to its next airport and on through any later ones, and every airport of the route
 * as a labelled point. Recomputed from the aircraft's newest position on each pass, so the
 * dashed line shortens as it flies. Nothing when the route or any of its airports' positions
 * is unknown, or the flight is another object's.
 */
export function presentedRoute(
  object: WorldObject | null | undefined,
  flight: FlightState | null,
): PresentedRoute | undefined {
  const route = flight?.info?.route;
  if (!object || !route || flight?.objectId !== object.id || !object.position) return undefined;
  const airports = route.airports;
  if (airports.length < 2 || airports.some((a) => a.latitude === undefined || a.longitude === undefined))
    return undefined;
  const placed = airports.map((a) => ({
    latitude: a.latitude!,
    longitude: a.longitude!,
    ...(a.elevationM !== undefined ? { elevationM: a.elevationM } : {}),
  }));
  const progress = routeProgress(object.position, placed);
  if (!progress) return undefined;
  const from = {
    latitude: object.position.latitude,
    longitude: object.position.longitude,
    ...(object.position.altitudeM !== undefined ? { altitudeM: object.position.altitudeM } : {}),
  };
  return {
    remaining: remainingPath(from, placed, progress.leg),
    airports: airports.map((a, i) => ({
      position: { latitude: a.latitude!, longitude: a.longitude! },
      label: a.iata ?? a.icao ?? a.code,
      role: i === 0 ? 'origin' : i === airports.length - 1 ? 'destination' : 'stop',
    })),
  };
}
