import type { JsonValue } from '@worldview/world-model';
import { DEFAULT_SETTINGS } from '../settings-schema.js';
import type { Migration } from './runner.js';

/**
 * 004 — `history.maxMB`, the size cap on observation history. Same reason as 003: the
 * document is validated whole, so a file without the key would be quarantined. Fills the
 * default and touches nothing else.
 */
export const historyCapMigration: Migration = {
  version: 4,
  name: 'history-size-cap-default',
  async up(ctx) {
    const doc = ctx.document;
    const settings =
      typeof doc.settings === 'object' && doc.settings !== null && !Array.isArray(doc.settings) ? doc.settings : {};
    if (settings['history'] === undefined)
      settings['history'] = structuredClone(DEFAULT_SETTINGS.history) as unknown as JsonValue;
    doc.settings = settings;
  },
};
