/**
 * @worldview/render-core — the rendering contract (RenderFeature, WorldRenderer,
 * ViewState), the presentation pipeline (LOD, clustering, density, lens rules),
 * lens definitions, the shared theme and icon set, the frame scheduler, the
 * presentation worker protocol and the RendererHost that owns the 2D/3D adapters.
 * Platform-agnostic: no Cesium, no MapLibre, no DOM beyond the `HTMLElement` type
 * in the renderer interface.
 */
export * from './contract.js';
export * from './presentation.js';
export * from './lenses.js';
export * from './map-providers.js';
export * from './theme.js';
export * from './icons.js';
export * from './scheduler.js';
export * from './presentation-worker.js';
export * from './renderer-host.js';
export { FakeWorldRenderer } from './testing/fake-renderer.js';
