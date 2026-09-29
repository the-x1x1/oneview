import type { JsonValue } from '@worldview/world-model';
import { DEFAULT_SETTINGS } from '../settings-schema.js';
import type { Migration } from './runner.js';

/**
 * 006 — `display`: graphics quality, the visual style, the HUD and the day/night shading.
 * Same reason as 003–005: the document is validated whole, so a file without the key would be
 * quarantined. Fills the defaults (Auto quality, standard style, both overlays off) and
 * touches nothing else.
 */
export const displayMigration: Migration = {
  version: 6,
  name: 'display-defaults',
  async up(ctx) {
    const doc = ctx.document;
    const settings =
      typeof doc.settings === 'object' && doc.settings !== null && !Array.isArray(doc.settings) ? doc.settings : {};
    if (settings['display'] === undefined)
      settings['display'] = structuredClone(DEFAULT_SETTINGS.display) as unknown as JsonValue;
    doc.settings = settings;
  },
};
