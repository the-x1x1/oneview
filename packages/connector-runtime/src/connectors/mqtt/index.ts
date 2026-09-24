/**
 * Phase `mqtt`: the MQTT connector (`mqtt.ts`), its topic rules (`topics.ts`), the payload
 * presets for rtl_433, OwnTracks and Meshtastic (`presets.ts`) and the definition block it
 * reads (`contract.ts`, re-exporting the definition schema's `mqtt` block, ADR-013 amendment
 * M1). The shared suite runs an MQTT definition through `testing/suite.ts` (amendment M2).
 */
export * from './contract.js';
export * from './topics.js';
export * from './presets.js';
export * from './mqtt.js';
