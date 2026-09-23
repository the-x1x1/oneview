import { initialMigration } from './001-initial.js';
import { dataLayoutMigration } from './002-data-layout.js';
import { newDefaultsMigration } from './003-new-defaults.js';
import { historyCapMigration } from './004-history-cap.js';
import { referenceLayerMigration } from './005-reference-layer.js';
import { latestVersion, type Migration } from './runner.js';

export * from './runner.js';

/** Ordered registry. Add new migrations at the end with the next version number. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  initialMigration,
  dataLayoutMigration,
  newDefaultsMigration,
  historyCapMigration,
  referenceLayerMigration,
]);

/** The schemaVersion a freshly written settings.json carries. */
export const CURRENT_SCHEMA_VERSION = latestVersion(MIGRATIONS);
