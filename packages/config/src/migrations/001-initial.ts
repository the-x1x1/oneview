import type { JsonValue } from '@worldview/world-model';
import { DEFAULT_SETTINGS } from '../settings-schema.js';
import type { Migration } from './runner.js';

/**
 * 001 — initial settings document.
 *
 * Fresh installs start from `{}`; pre-release builds wrote settings without an
 * envelope. Both become `{ schemaVersion, settings }` with every key present, taking
 * defaults for anything missing. Unknown keys are dropped (they cannot be trusted).
 */
export const initialMigration: Migration = {
  version: 1,
  name: 'initial-settings-envelope',
  async up(ctx) {
    const doc = ctx.document;
    const legacy = isObject(doc.settings) ? doc.settings : {};
    const settings: Record<string, JsonValue> = {};
    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
      const candidate = legacy[key];
      settings[key] = candidate !== undefined ? candidate : (structuredClone(fallback) as JsonValue);
    }
    doc.settings = settings;
  },
};

function isObject(v: JsonValue | undefined): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
