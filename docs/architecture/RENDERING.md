# Rendering

Packages `@worldview/render-core`, `@worldview/render-cesium`, `@worldview/render-maplibre`
and `@worldview/render-dense` implement ADR-008: one `WorldRenderer` contract, two
adapters (Cesium globe, MapLibre map), level-of-detail in the presentation layer, and a
host that owns the active adapter. Renderers never see providers, observations or raw
payloads; they consume `RenderFeature`s only (contract frozen in
`packages/render-core/src/contract.ts`).

## Pipeline

```mermaid
flowchart LR
  WS[WorldState\nWorldObject / WorldEvent] --> H[RendererHost\nrender-core/renderer-host.ts]
  H -->|"> 5,000 objects"| W[PresentationWorker\nMessagePort → presentObjects]
  H -->|"≤ 5,000 objects"| P[presentObjects\nlens rules · LOD band · clustering · density · priority cap]
  W --> P
  P --> D[diffFeatures\nupsert / remove only]
  D --> R{active WorldRenderer}
  R -->|3D| C[CesiumWorldRenderer\nPointPrimitive · Billboard · Label · Polyline · Entity · GroundPrimitive]
  R -->|2D| M[MapLibreWorldRenderer\nGeoJSON source per layer · circle / symbol / line / fill layers]
  C -->|pick · hover · viewChanged| H
  M -->|pick · hover · viewChanged| H
  H -->|ViewState · selection · lens · basemap · attribution| C
  H -->|ViewState · selection · lens · basemap · attribution| M
```

- `RendererHost` (`render-core/src/renderer-host.ts`) owns both adapters, mounts them
  lazily, resolves `AUTO` (2D when `webgl2` is false, `lowPower` is set, or the user chose
  2D for offline use without terrain), keeps ViewState / selection / lens / basemap /
  attribution in sync when switching (directive §49), suspends the hidden renderer, and
  runs presentation at most once per animation frame (`FrameCoalescer`). Above the
  worker threshold the pure `presentObjects` runs through a `PresentationWorker`
  (`PortPresentationWorker` + `servePresentation` over any MessagePort pair; the shell
  provides the Web Worker). Stale worker replies are dropped by generation.
- The theme (`render-core/src/theme.ts`) maps style classes to colours/sizes for the dark
  UI, dims `STALE` (opacity 0.5, desaturated) and `HISTORICAL`, and adds selection /
  hover outlines. The icon set (`render-core/src/icons.ts`) is drawn with canvas paths —
  no SVG or font assets — and tinted per renderer.

## Level of detail

`presentObjects` picks a mode per object type and zoom band (`DEFAULT_RULES`; a lens may
override). Clustering is screen-space grid clustering in the pipeline; MapLibre adds its
own clustering below zoom 9 for clusterable layers.

| Band | Zoom | aircraft / vessel | satellite | earthquake | fire-detection | camera | infrastructure / airport / port / place | weather-alert / storm | launch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| global | < 3 | density cells (5°) | points | markers | density (5°) | hidden | hidden | markers | markers |
| continental | 3–6 | points, cluster 24 px | points | markers | density (1°) | density (1°) | points, cluster 20 px | markers | markers |
| regional | 6–10 | markers, cluster 24 px | markers | markers | points, cluster 16 px | points | markers | markers | icons |
| local | ≥ 10 | icons + labels | markers | icons + `M x.x` label | markers | icons | icons | icons | icons |

Cesium routes each `RenderFeature` by geometry and style (`featureRouter.ts`): point →
`PointPrimitiveCollection`, point with icon → `BillboardCollection` (sprite tinted by
colour, rotation from heading, `alignedAxis = UNIT_Z` so north stays up), label →
`LabelCollection` with a priority-based screen-space declutter pass
(`labelDeclutter.ts`), line/trail → `PolylineCollection` (dash materials), polygon /
circle → entities in a `CustomDataSource` (draped, classification BOTH), density → one
`GroundPrimitive` of colour-attributed rectangles per layer (entity rectangles where
ground primitives are unsupported), cluster → billboard disc + centred count label.
Height modes: `absolute` keeps aircraft/satellite altitudes, `clamp` draws at the surface
with `CLAMP_TO_GROUND`, `relative` offsets from the ground.

MapLibre keeps one GeoJSON source per layer (`sources.ts` diffs updates and marks dirty
layers; one `setData` per dirty layer per frame). Layer set per source (`layers.ts`):
density fill, area fill + outline, solid and dashed lines, circles, icon symbols
(`icon-allow-overlap: false`, `text-optional: true`, `symbol-sort-key` = −priority),
text-only labels, cluster discs and counts.

## Basemap and terrain registry

3D stacks (`render-cesium/src/basemaps.ts`, adapted from GEV's `MapSourceController`;
generation-counted switching, construction fallback, tile-failure fallback after 2
errors, on-screen credit that follows the stack actually shown):

| Stack id | Source | Credentials | Legal review | Default |
| --- | --- | --- | --- | --- |
| `natural-earth` | Cesium's bundled Natural Earth II (`buildModuleUrl('Assets/Textures/NaturalEarthII')`) on `EllipsoidTerrainProvider` | none, no network | approved | **yes** (also the recovery stack) |
| `esri-world-imagery` | `ArcGisMapServerImageryProvider` World_Imagery | none | conditional (C-1) | no |
| `osm-raster` | `OpenStreetMapImageryProvider` tile.openstreetmap.org | none | conditional (E-9) — never default | no |
| `cesium-ion-bing` | `IonImageryProvider` asset 3 | user's ion token | conditional (C-8) | no |
| `google-3d` | `createGooglePhotorealistic3DTileset` | user's key via `credentialRef` only | conditional (C-9 / E-8) | no |
| `raster-xyz:<id>` | `UrlTemplateImageryProvider` from a `raster-xyz` descriptor | none | approved unless OSM host | no |
| `none` | bare globe with the dark base colour | none | approved | no |

Terrain (`render-cesium/src/terrain.ts`, applied through `CesiumWorldRenderer.setTerrain`,
cached per descriptor, generation-guarded): `ellipsoid` (default), `quantized-mesh` URL
(e.g. Re:Earth / Mapterhorn ellipsoidal mesh, CC BY 4.0), `cesium-ion-world-terrain`
(token), `local` (worldpack terrain served by the shell).

2D styles (`render-maplibre/src/styles/worldview-dark.ts`): `pmtiles` descriptors become
the typed dark/light style for the Protomaps basemap schema over `pmtiles://` (worldpacks,
zero network); `vector-style` passes a style URL through (OpenFreeMap pending C-3 sign-off,
or a user style); `raster-xyz` / `esri-world-imagery` become raster styles; globe-only
kinds fall back to the plain dark canvas with an `error` event.

`BasemapDescriptor`s come from the map-provider registry, never from renderer code; the
shell chooses per mode and `RendererHost` remembers the choice per mode.

## Dense layers and benchmarks

`@worldview/render-dense` defines `DenseLayerRenderer` and the `NativeDenseAdapter`
that replaces a layer wholesale on the active renderer within a `DenseBudget` (per-band
caps, priority-ordered, scalable under low power). deck.gl is added only if
`tools/benchmark` shows the native adapters missing the 30 FPS heavy-region target.

`pnpm benchmark` runs the CPU-side harness (`render-dense/src/benchmark.ts`) and writes
`artifacts/verification/benchmarks/presentation.json`: `presentObjects` + `diffFeatures`
at 1k / 10k / 50k / 100k synthetic objects across the global / regional / local bands.
On the build container (Node 22, x64) `presentObjects` stays under one 60 FPS frame at
100k objects and local zoom (≈10 ms); `diffFeatures` dominates above 50k features
(82 ms at 14k changed features, JSON-equality per feature) and is the first optimisation
target if 100k-object regions become common.

## What needs the operator machine

Nothing here runs WebGL: the adapters are exercised in Node against fake module
surfaces (`render-cesium/src/testing/fake-cesium.ts`,
`render-maplibre/src/testing/fake-maplibre.ts`), and the real `cesium`, `maplibre-gl`
and `pmtiles` packages were not installable in the build container (declaration shims
in `tools/dev/type-shims/` stand in for their types). To verify on the operator machine:

1. `pnpm install` so the real packages replace the shims; `pnpm typecheck` must pass —
   `cesium-module.ts` and `maplibre-module.ts` are the only files typed against the
   libraries, so any signature drift surfaces there.
2. Run the tests: the two "real module" tests in `render-cesium/src/renderer.test.ts` and
   `render-maplibre/src/renderer.test.ts` stop skipping and assert the members the
   adapters rely on exist.
3. Desktop smoke test with WebGL: Natural Earth II globe renders with zero network; an
   Esri/OSM stack switch shows the credit line; a PMTiles worldpack renders offline in 2D;
   the 2D/3D switch preserves centre, zoom and selection; picks and hover work on both;
   `frame` events report ≥ 30 FPS with the presentation benchmark's 50k-object set
   loaded (the deck.gl decision point).
4. Sprite orientation: confirm billboard icons point along heading with `alignedAxis =
   UNIT_Z` at high latitudes and that MapLibre `icon-rotate` matches (both use clockwise
   degrees from north).
