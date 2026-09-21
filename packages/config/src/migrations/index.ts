import { initialMigration } from './001-initial.js';
import { dataLayoutMigration } from './002-data-layout.js';
import { latestVersion, type Migration } from './runner.js';

export * from './runner.js';

/** Ordered registry. Add new migrations at the end with the next version number. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([initialMigration, dataLayoutMigration]);

/** The schemaVersion a freshly written settings.json carries. */
export const CURRENT_SCHEMA_VERSION = latestVersion(MIGRATIONS);
