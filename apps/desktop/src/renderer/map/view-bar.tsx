import { isBasemapOverlay, type RasterOverlay } from '@worldview/world-model';
import { VISUAL_STYLE_IDS, type VisualStyleId } from '@worldview/ipc-contract';
import type { ResolvedMapProvider } from '@worldview/render-core';
import { useActions, useAppState } from '../store/store.js';
import { displaySettings, VISUAL_STYLE_NAMES } from '../store/display.js';
import { sourceBasemapId } from '../map-providers.js';
import { WEATHER_GROUP_ID, WEATHER_IMAGERY, isImageryView, weatherImageryOn } from '../weather-imagery.js';

/**
 * One bar at the foot of the map for every picture it can show, so the operator picks what
 * to look at in one place instead of in Settings, Sources and the layer panel:
 *
 * - **Map** — one choice: a basemap (satellite, the offline dark map, streets, …), a source's
 *   whole map, or a full-cover imagery layer over it (NASA's daily true colour). Two of these
 *   drawn together hid one another, so choosing one is choosing it alone.
 * - **Weather** — the pictures that lie over any map: clouds, rain, radar, lightning. They
 *   layer cleanly (clouds in grey, rain in colour) except rain and radar, which are the same
 *   colours for the same thing: one of the two at a time.
 * - **Look** — the visual style (night vision, thermal, …), one at a time.
 *
 * Everything here writes the same settings the other places do (basemap, `display`, the
 * hidden layer list), so they all agree.
 */

export interface ViewChoice {
  id: string;
  label: string;
  title: string;
}

const BASEMAP_LABELS: Readonly<Record<string, string>> = {
  'natural-earth': 'Natural Earth',
  'worldview-dark': 'Dark',
  'worldview-light': 'Light',
  'esri-world-imagery': 'Satellite HD',
  'osm-raster': 'Streets',
  'cesium-ion-bing': 'Bing Aerial',
  none: 'None',
};

/** A short name for a basemap on the bar. */
export function basemapLabel(entry: Pick<ResolvedMapProvider, 'id' | 'name'>): string {
  return BASEMAP_LABELS[entry.id] ?? entry.name.replace(/\s*\(.*\)\s*$/, '');
}

/** A short name for a full-cover imagery layer on the bar. */
export function imageryLabel(o: Pick<RasterOverlay, 'providerId' | 'name'>): string {
  if (/noaa-?20/i.test(o.providerId)) return 'True colour · NOAA-20';
  if (/snpp|suomi/i.test(o.providerId)) return 'True colour · Suomi NPP';
  return o.name.length > 28 ? `${o.name.slice(0, 27)}…` : o.name;
}

/**
 * The Map choices for a mode: the basemaps usable in it, the sources' whole maps, then the
 * imagery layers the running sources publish (one entry per source, whatever its frame).
 * Prefixed ids keep the three kinds apart: `basemap:`, `imagery:`.
 */
export function mapChoices(
  basemaps: readonly ResolvedMapProvider[],
  overlays: readonly RasterOverlay[],
  mode: '2D' | '3D',
): ViewChoice[] {
  const out: ViewChoice[] = [];
  for (const b of basemaps)
    if (b.available && b.modes.includes(mode))
      out.push({ id: `basemap:${b.id}`, label: basemapLabel(b), title: b.name });
  const seen = new Set<string>();
  for (const o of overlays) {
    if (isBasemapOverlay(o)) {
      const id = `basemap:${sourceBasemapId(o)}`;
      if (!seen.has(id)) out.push({ id, label: o.name, title: `${o.name} — a source's own map` });
      seen.add(id);
    } else if (isImageryView(o) && !seen.has(o.providerId)) {
      seen.add(o.providerId);
      out.push({
        id: `imagery:${o.providerId}`,
        label: imageryLabel(o),
        title: `${o.name}${o.frame ? ` (${o.frame})` : ''} — over the basemap`,
      });
    }
  }
  return out;
}

/** Which Map choice is the current one: the imagery layer if one is chosen and published, else the basemap. */
export function activeMapChoice(
  choices: readonly ViewChoice[],
  basemapId: string | undefined,
  imagery: string | undefined,
): string | undefined {
  if (imagery && choices.some((c) => c.id === `imagery:${imagery}`)) return `imagery:${imagery}`;
  return basemapId ? `basemap:${basemapId}` : undefined;
}

export function ViewBar() {
  const { session, sources, ui } = useAppState();
  const actions = useActions();
  const settings = session.settings;
  if (!settings) return null;
  const display = displaySettings(settings);
  const hidden = settings.hiddenLayers ?? [];
  const mode = ui.activeMode;
  const choices = mapChoices(session.mapProviders?.basemaps ?? [], sources.overlays, mode);
  const active = activeMapChoice(choices, settings.basemapId, display.imagery);
  const weatherOff = hidden.includes(WEATHER_GROUP_ID);

  const pickMap = (id: string) => {
    if (id.startsWith('imagery:')) {
      void actions.setImageryView(id.slice('imagery:'.length));
      return;
    }
    const basemapId = id.slice('basemap:'.length);
    void actions.setImageryView(undefined);
    if (basemapId !== settings.basemapId) void actions.updateSettings({ basemapId });
  };

  return (
    <div className="wv-viewbar" role="toolbar" aria-label="Map view">
      <div className="wv-viewbar__group" role="radiogroup" aria-label="Map">
        <span className="wv-viewbar__label">Map</span>
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={active === c.id}
            className={`wv-viewbar__chip${active === c.id ? ' wv-viewbar__chip--on' : ''}`}
            title={c.title}
            onClick={() => pickMap(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="wv-viewbar__group" role="group" aria-label="Weather">
        <span className="wv-viewbar__label">Weather</span>
        {WEATHER_IMAGERY.map((w) => {
          const on = !weatherOff && weatherImageryOn(hidden, w.id);
          const has = sources.overlays.some((o) => w.matches(o.providerId));
          return (
            <button
              key={w.id}
              type="button"
              role="switch"
              aria-checked={on}
              className={`wv-viewbar__chip${on ? ' wv-viewbar__chip--on' : ''}${has ? '' : ' wv-viewbar__chip--idle'}`}
              title={`${w.name}: ${w.description}${has ? '' : ' — no source is publishing it right now'}${
                w.id === 'imagery.radar' || w.id === 'imagery.precipitation' ? ' (radar and rain are one choice)' : ''
              }`}
              onClick={() => void actions.setWeatherImagery(w.id, !on)}
            >
              {w.name === 'Satellite clouds' ? 'Clouds' : w.name === 'Precipitation' ? 'Rain' : w.name}
            </button>
          );
        })}
      </div>
      <div className="wv-viewbar__group" aria-label="Look">
        <label className="wv-viewbar__label" htmlFor="wv-viewbar-look">
          Look
        </label>
        <select
          id="wv-viewbar-look"
          className="wv-viewbar__select"
          value={display.visualStyle}
          onChange={(e) => void actions.setVisualStyle(e.target.value as VisualStyleId)}
        >
          {VISUAL_STYLE_IDS.map((id) => (
            <option key={id} value={id}>
              {VISUAL_STYLE_NAMES[id]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
