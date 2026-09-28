import type { AppSettings } from '@worldview/ipc-contract';
import type { VisualStyleId } from '@worldview/render-core';

/**
 * The display settings (schema 6) with their defaults filled in. Settings from before schema
 * 6 are migrated on load, but a settings object held in memory from an older runtime — or a
 * test's — may still lack them, and every reader should see the same defaults.
 */
export const DISPLAY_DEFAULTS: AppSettings['display'] = Object.freeze({
  graphics: 'auto',
  visualStyle: 'standard',
  hud: false,
  dayNight: false,
});

export function displaySettings(settings: AppSettings | null | undefined): AppSettings['display'] {
  return { ...DISPLAY_DEFAULTS, ...settings?.display };
}

/** Names of the visual styles as the HUD and the palette show them. */
export const VISUAL_STYLE_NAMES: Readonly<Record<VisualStyleId, string>> = Object.freeze({
  standard: 'Standard',
  'night-vision': 'Night vision',
  thermal: 'Thermal',
  crt: 'CRT',
  noir: 'Noir',
});

/** The renderer's feature id for a selected object, and back (map-host presents objects as `obj:<id>`). */
export const objectFeatureId = (objectId: string): string => `obj:${objectId}`;
export const objectIdOfFeature = (featureId: string): string | null =>
  featureId.startsWith('obj:') ? featureId.slice(4) : null;
