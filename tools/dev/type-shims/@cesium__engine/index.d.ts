/**
 * Declaration shim for @cesium/engine, used only when the package is not installed
 * (see tools/dev/typecheck.mjs). The engine is the half of Cesium that WORLDVIEW imports
 * at run time — the other half, @cesium/widgets, is deliberately absent from the bundle
 * because its Knockout copy evaluates a string at module scope and the renderer's CSP
 * forbids that (see packages/render-cesium/src/cesium-module.ts).
 *
 * The neighbouring `cesium` shim already declares these symbols, so this re-exports them
 * rather than keeping a second copy that could drift. Every symbol WORLDVIEW takes from
 * the engine is declared there; `Viewer` is declared there too and is NOT part of the
 * engine, which is why nothing imports it from this module.
 */
export * from '../cesium/index.js';
