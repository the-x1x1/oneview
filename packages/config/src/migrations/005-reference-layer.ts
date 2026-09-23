import type { JsonValue } from '@worldview/world-model';
import { DEFAULT_SETTINGS } from '../settings-schema.js';
import type { Migration } from './runner.js';

/**
 * 005 — `reference`, the borders-and-names layer switches. Same reason as 003 and 004: the
 * document is validated whole, so a file without the key would be quarantined. Fills the
 * default (both on) and touches nothing else.
 */
export const referenceLayerMigration: Migration = {
  version: 5,
  name: 'reference-layer-default',
  async up(ctx) {
    const doc = ctx.document;
    const settings =
      typeof doc.settings === 'object' && doc.settings !== null && !Array.isArray(doc.settings) ? doc.settings : {};
    if (settings['reference'] === undefined)
      settings['reference'] = structuredClone(DEFAULT_SETTINGS.reference) as unknown as JsonValue;
    doc.settings = settings;
  },
};
