import type { JsonValue } from '@worldview/world-model';
import type { Migration } from './runner.js';

/**
 * 007 — two layer switches that are off until the operator turns them on: Aircraft →
 * Military only, and Public cameras → Live previews (the shell's layer-tree.ts).
 *
 * `hiddenLayers` lists what is hidden, so a switch added later is on by default — right for
 * a new category, wrong for these two: one narrows what the map shows, the other starts
 * live video. New installations have both in the default list; this puts them in the list
 * of a settings file written before they existed, once. After that the list is the
 * operator's: turning one on takes it out, and no later start puts it back.
 */
export const optInLayersMigration: Migration = {
  version: 7,
  name: 'opt-in-layer-switches',
  async up(ctx) {
    const doc = ctx.document;
    const settings =
      typeof doc.settings === 'object' && doc.settings !== null && !Array.isArray(doc.settings) ? doc.settings : {};
    const hidden = Array.isArray(settings['hiddenLayers']) ? settings['hiddenLayers'] : [];
    const next: JsonValue[] = [...hidden];
    for (const id of OPT_IN_LAYERS) if (!next.includes(id)) next.push(id);
    settings['hiddenLayers'] = next;
    doc.settings = settings;
  },
};

/** The opt-in switches as of this migration. Fixed: a migration describes its own moment. */
const OPT_IN_LAYERS = ['aircraft.military-only', 'camera.previews'];
