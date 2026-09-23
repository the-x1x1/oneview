import type { JsonValue } from '@worldview/world-model';
import { DEFAULT_SETTINGS } from '../settings-schema.js';
import type { Migration } from './runner.js';

/**
 * 003 — settings added after the first release candidates: `hiddenLayers` (the Overview's
 * per-category switches) and `tileCache` (the on-disk map tile cache).
 *
 * The settings document is validated whole, so a file written by an earlier build — without
 * these keys — would fail validation and be quarantined, taking the operator's basemap,
 * lens and provider choices with it. This fills in defaults for any key the document lacks
 * and touches nothing it has.
 */
export const newDefaultsMigration: Migration = {
  version: 3,
  name: 'hidden-layers-and-tile-cache-defaults',
  async up(ctx) {
    const doc = ctx.document;
    const settings =
      typeof doc.settings === 'object' && doc.settings !== null && !Array.isArray(doc.settings) ? doc.settings : {};
    // The category lenses became layers of the Overview in the same release. Someone who had
    // one of them open keeps seeing the same thing: the Overview with only that layer on.
    const active = settings['activeLensId'];
    if (settings['hiddenLayers'] === undefined && typeof active === 'string' && CATEGORY_LENSES.includes(active)) {
      settings['hiddenLayers'] = CATEGORY_LENSES.filter((id) => id !== active);
      settings['activeLensId'] = 'overview';
    }
    for (const key of ['hiddenLayers', 'tileCache'] as const) {
      if (settings[key] === undefined) settings[key] = structuredClone(DEFAULT_SETTINGS[key]) as unknown as JsonValue;
    }
    doc.settings = settings;
  },
};

/** The built-in category lenses as of this migration (render-core/src/lenses.ts). Fixed: a migration describes its own moment. */
const CATEGORY_LENSES = [
  'aviation',
  'maritime',
  'space',
  'weather',
  'disasters',
  'transportation',
  'infrastructure',
  'environment',
];
