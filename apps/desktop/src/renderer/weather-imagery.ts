import type { RasterOverlay } from '@worldview/world-model';
import type { LensDefinition } from '@worldview/render-core';
import { OVERVIEW_LENS_ID } from './overview-layers.js';

/**
 * The weather pictures laid over the map — satellite clouds, precipitation, radar, lightning —
 * as switches inside the layer panel's Weather group, so turning Weather off takes them off
 * the map too. Before, they were drawn whatever the panel said: Weather off still left the
 * whole globe under infrared cloud and rain colours.
 *
 * An overlay belongs to one of these by its source's id (the shipped connector definitions
 * name what they are: `gibs-goes-east-infrared`, `gibs-imerg-precipitation`,
 * `nowcoast-radar`, `nowcoast-strike-density`). An overlay that matches none — a basemap
 * from a source, the true-colour imagery the comparison uses, an operator's own WMS — is not
 * weather and no weather switch touches it.
 *
 * The switches write the same hidden list as every other (layer-tree.ts); they are on until
 * switched off.
 */
export interface WeatherImageryLayer {
  /** `imagery.<kind>`, in the hidden list when off. */
  id: string;
  name: string;
  description: string;
  matches: (providerId: string) => boolean;
}

export const WEATHER_GROUP_ID = 'weather';

export const WEATHER_IMAGERY: readonly WeatherImageryLayer[] = Object.freeze([
  {
    id: 'imagery.infrared',
    name: 'Satellite clouds',
    description: 'Infrared cloud imagery from five geostationary satellites, clouds only, day and night',
    matches: (p: string) => /infrared/i.test(p),
  },
  {
    id: 'imagery.precipitation',
    name: 'Precipitation',
    description: 'Satellite-estimated rain and snow worldwide (IMERG); hidden close in',
    matches: (p: string) => /imerg|precipitation/i.test(p),
  },
  {
    id: 'imagery.radar',
    name: 'Radar',
    description: 'Weather radar over the US (NOAA MRMS)',
    matches: (p: string) => /radar/i.test(p),
  },
  {
    id: 'imagery.lightning',
    name: 'Lightning',
    description: 'Lightning strike density over the Americas',
    matches: (p: string) => /strike|lightning/i.test(p),
  },
]);

/** The weather switch an overlay answers to, or undefined when it is not weather imagery. */
export function weatherImageryFor(o: Pick<RasterOverlay, 'providerId'>): WeatherImageryLayer | undefined {
  return WEATHER_IMAGERY.find((l) => l.matches(o.providerId));
}

/**
 * Whether weather imagery may show at all under this lens: in the Overview, when its Weather
 * group is on; in another lens, when that lens is about weather (it shows storms or weather
 * alerts) — the Aviation lens is not a place for rain colours.
 */
export function weatherImageryAllowed(
  lens: Pick<LensDefinition, 'id' | 'objectTypes'> | undefined,
  hidden: readonly string[],
): boolean {
  if (!lens || lens.id === OVERVIEW_LENS_ID) return !hidden.includes(WEATHER_GROUP_ID);
  return lens.objectTypes.includes('storm') || lens.objectTypes.includes('weather-alert');
}

/**
 * Rain from two sources over each other is one picture too many: IMERG's 10 km squares showed
 * around every US radar echo in the same colours. Radar and precipitation are one choice —
 * turning one on turns the other off (the view bar, the layer panel) — and a hidden list that
 * has both on (every list written before this rule) shows precipitation.
 */
export const RAIN_CHOICES: readonly string[] = Object.freeze(['imagery.precipitation', 'imagery.radar']);

/** Whether a weather imagery switch is in effect: on in the list, and not overruled by its rival. */
export function weatherImageryOn(hidden: readonly string[], id: string): boolean {
  if (hidden.includes(id)) return false;
  if (id === 'imagery.radar') return hidden.includes('imagery.precipitation');
  return true;
}

/** The hidden list with one weather imagery switch set — its rival switched off when it goes on. */
export function withWeatherImagery(hidden: readonly string[], id: string, on: boolean): string[] {
  const rest = hidden.filter((h) => h !== id);
  if (!on) return [...rest, id];
  const rival = RAIN_CHOICES.includes(id) ? RAIN_CHOICES.find((r) => r !== id) : undefined;
  return rival && !rest.includes(rival) ? [...rest, rival] : rest;
}

/** Imagery that is neither weather nor a whole basemap: a full-cover picture such as NASA's daily true colour. */
export function isImageryView(o: Pick<RasterOverlay, 'providerId' | 'role'>): boolean {
  return o.role !== 'basemap' && weatherImageryFor(o) === undefined;
}

export interface OverlayChoices {
  /** The one imagery view chosen (settings `display.imagery`), by provider id. */
  imagery?: string | undefined;
  /** The imagery comparison is open: both of its sides are drawn whatever the choice. */
  comparing?: boolean;
}

/**
 * The overlays to draw, so that nothing drawn hides something else drawn:
 * - weather imagery only where its switches let it (radar and precipitation one at a time),
 *   and above every other overlay — clouds and rain over a true-colour mosaic, never under it;
 * - of the full-cover imagery views, only the one chosen (both sides while comparing);
 * - an infrared picture that is not one of the seamed slices (nowCOAST's GOES mosaic) only when
 *   no slice is drawn, since it covers the same sky with a different picture.
 * Order is otherwise kept; whole basemaps pass through (map-providers.ts draws them alone).
 */
export function visibleOverlays<T extends Pick<RasterOverlay, 'providerId' | 'role' | 'featherDeg'>>(
  overlays: readonly T[],
  lens: Pick<LensDefinition, 'id' | 'objectTypes'> | undefined,
  hidden: readonly string[],
  choices: OverlayChoices = {},
): T[] {
  const allowed = weatherImageryAllowed(lens, hidden);
  const other: T[] = [];
  const weather: T[] = [];
  for (const o of overlays) {
    const layer = weatherImageryFor(o);
    if (!layer) {
      if (o.role === 'basemap' || choices.comparing || o.providerId === choices.imagery) other.push(o);
    } else if (allowed && weatherImageryOn(hidden, layer.id)) weather.push(o);
  }
  const sliced = weather.some((o) => weatherImageryFor(o)?.id === 'imagery.infrared' && o.featherDeg);
  const shown = sliced
    ? weather.filter((o) => weatherImageryFor(o)?.id !== 'imagery.infrared' || o.featherDeg)
    : weather;
  return [...other, ...shown];
}

/**
 * What the map draws while the imagery comparison is open. The comparison lays every imagery
 * view out so that each can be chosen for a side (`visibleOverlays` with `comparing`); one on
 * neither side, and not the view chosen outside the comparison, is not drawn — else a side
 * set to "Map only" showed a true-colour mosaic anyway, at full cover, both VIIRS layers over
 * the whole map (seen on the test laptop, 2026-10-04). Weather imagery and basemaps pass.
 */
export function drawnWhileComparing<T extends Pick<RasterOverlay, 'providerId' | 'role'>>(
  overlays: readonly T[],
  split: { left: string | null; right: string | null } | null | undefined,
  chosenImagery: string | undefined,
): T[] {
  if (!split) return [...overlays];
  return overlays.filter(
    (o) =>
      !isImageryView(o) ||
      o.providerId === split.left ||
      o.providerId === split.right ||
      o.providerId === chosenImagery,
  );
}
