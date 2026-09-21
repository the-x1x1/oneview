# ADR-008 — Rendering: one contract, two adapters, LOD in the presentation layer

Status: Accepted · 2026-09-21 · Packages: `@worldview/render-core`, `@worldview/render-cesium`, `@worldview/render-maplibre`, `@worldview/render-dense`

## Decision
- Renderers implement `WorldRenderer` and consume `RenderFeature`s only. The presentation pipeline (`presentObjects`) applies lens visibility, per-type LOD (`density → points → markers → icons`), screen-space grid clustering, priority capping and selected-object trails, and is pure (worker-safe).
- `render-cesium` adapts GEV's viewer setup, keyless imagery/terrain factories and map-stack controller (generation-counted switching), with Natural Earth II + ellipsoid as the zero-credential default and Google 3D as an optional adapter. Point/billboard/polyline primitive collections per layer; picking via `scene.pick`; attribution through `creditDisplay`.
- `render-maplibre` renders GeoJSON sources per layer with MapLibre's clustering, the PMTiles protocol for offline packs and OpenFreeMap (pending legal sign-off) / user-configured styles online.
- 2D/3D/AUTO modes share `ViewState` (center, zoom↔altitude, heading, pitch, selection, lens, time cursor); the hidden renderer is suspended.
- `render-dense` defines the dense-layer abstraction; deck.gl is added only if `tools/benchmark` shows the native adapters missing the 30 FPS heavy-region target.
- 2026-09-21 amendment (runtime composition): `setTerrain?(t: TerrainDescriptor)` is an optional method on `WorldRenderer` itself (implemented by `render-cesium`, absent in `render-maplibre`), so `RendererHost` calls it through optional chaining instead of duck-typing the adapter.

## Consequences
Adding a provider never touches renderer code: new object types get a `RenderingRule` and a style class in the theme.
