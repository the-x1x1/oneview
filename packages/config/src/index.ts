/**
 * @worldview/config — typed settings store with atomic persistence, versioned
 * migrations for settings and the userData layout, and the startup validator.
 * Node-only (main process, tools). The renderer reads settings through IPC.
 */
export * from './settings-schema.js';
export * from './settings-store.js';
export * from './data-dirs.js';
export * from './migrations/index.js';
export * from './startup-validator.js';
