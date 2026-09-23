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
  H -->|"≤ 5,000 objects"| P[presentObjects\nlens rules · LOD band · priority cap]
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
override).

**Every object is its own point at every zoom, and nothing is grouped.** The overview first
hid half the types and drew the busy ones as density heatmaps; the next version kept every
type but folded crowds into counted cluster bubbles. Both answer "roughly how many" and not
"where, exactly, is each one", and the operator asked for every dot separate. A GPU point is
cheap — Cesium's `PointPrimitiveCollection` and MapLibre's circle layer each draw tens of
thousands per frame — so the only thing that has to be true for that to be smooth is that the
CPU is not rebuilding them every frame (see _Motion_ below).

Clustering (`clusterPx`) and density (`densityCellDeg`) remain in the rule format for a lens
that genuinely wants aggregation. No default rule sets either, and MapLibre's own
source-level clustering is driven by the same field, so it is off in 2D as well.

Bands are in ViewState zoom: the 256-pixel web-mercator convention, the one Cesium's camera
altitude converts to (render-core `altitudeToZoom`, which takes the viewport's size).
MapLibre counts 512-pixel tiles, so its own zoom is one lower for the same view; the 2D
renderer converts both ways (`MAPLIBRE_ZOOM_OFFSET`), and a switch between modes keeps what
is on screen rather than the number.

| Object type                             | global (< 3) | continental (3–6) | regional (6–10) | local (≥ 10)          |
| --------------------------------------- | ------------ | ----------------- | --------------- | --------------------- |
| aircraft                                | points       | points            | markers         | icons + labels        |
| vessel                                  | points       | points            | markers         | icons + labels        |
| satellite                               | points       | points            | markers         | markers               |
| earthquake                              | markers      | markers           | markers         | icons + `M x.x` label |
| fire-detection                          | points       | points            | points          | markers               |
| weather-alert / storm                   | markers      | markers           | markers         | icons                 |
| weather-station                         | points       | points            | markers         | icons                 |
| camera                                  | points       | points            | points          | icons                 |
| transit-vehicle                         | points       | points            | points          | icons                 |
| airport / port / infrastructure / place | points       | points            | markers         | icons                 |
| launch                                  | markers      | markers           | icons           | icons                 |
| sensor                                  | points       | points            | markers         | icons                 |

Earthquake markers are sized by magnitude and coloured by depth; a selected object is
always drawn at `icons`, whatever its band.

### Motion

Presentation depends on data, lens, selection, hover and **LOD band** — never on the exact
camera. Both renderers report a view change on nearly every frame of motion (Cesium's
`percentageChanged` is 1 %, MapLibre fires on `move`); the desktop shell used to put each one
into application state and re-run presentation over every object in response, on the thread
that also draws the map, which is what "buffering" while panning was. Now:

- view changes reach application state at most every 250 ms, always ending on the last one
  (`map/throttle.ts`);
- the presentation effect is keyed on the band, not the view;
- presentation does not cull to the view (`cullToView: false`) — the GPU culls for free, and
  culling here made the visible set a function of the camera, so points churned in and out
  at the edges of every pan. The data is already bounded upstream by the viewport
  subscription at any zoom where the whole world is not in view.

Changes reach the renderer a frame-budgeted slice at a time (`map/feature-feed.ts`: 500
features per step, stopping once a frame has spent 6 ms, latest-wins per id), starting the
frame after presentation. The satellite catalogue re-propagates every fifteen seconds and
moves all ~5,000 satellites at once; applied in one go that was a single 15–37 ms frame
(median ~19 ms) on the operator's machine.

The frame counters ignore time the window spends hidden: Chromium throttles a hidden or
covered window, and the first frame back used to report the whole absence as a 0 fps second.
The same goes for the globe's render loop being stopped while the 2D map is showing.

Hover is not resolved while the camera moves. In 3D every resolution is a `scene.pick` — a
second render of the primitives into a pick buffer and a synchronous read back from the GPU —
and a drag moves the pointer every frame; in 2D it is a `queryRenderedFeatures`. Whatever the
pointer rests on is resolved once the camera settles (Cesium's `moveEnd`, MapLibre's
`moveend`). A hover change on its own no longer re-presents the world either:
`restyleHover` produces the (at most two) features it touches from the frame already
presented, and a test holds it to exactly what a full pass would give.

In 2D, a layer MapLibre already holds is updated with `GeoJSONSource.updateData` (a diff)
rather than `setData`, which re-indexes every feature of the source in the worker; a refused
diff falls back to a full push for that layer. On the globe, the tile cache holds 400 tiles
(Cesium's default is 100) and siblings of drawn tiles are preloaded, so ground already shown
is not fetched again on the way back.

### Map tile cache (desktop)

Esri World Imagery tiles are served to both renderers from `worldview://app/__tiles/…`, the
page's own origin, by `apps/desktop/src/main/tile-cache.ts`. On a miss it fetches from Esri
and keeps the tile on disk (`userData/tiles/`); on a hit it serves the file, online or not.
The operator sets the size cap in Settings → Map tile cache (default 2 GB); the least
recently used tiles go first when it is reached. When the camera has been still for 0.7 s
the map host asks for the next two zoom levels of the view (`tiles.prefetch`), bounded to 64
tiles a level and fetched behind anything the page itself is loading. A whole-globe preload
to zoom 7 (21,845 tiles, ~400 MB) exists behind a switch that is off by default: whether
Esri's terms allow bulk download is the operator's decision.

Offline, `map.providers.list` keeps a cacheable source with tiles on disk selectable
(`cachedTileSources`, asked for only when offline since it waits for the cache's startup
scan) and marks it "Offline: only the tiles already cached on this computer"; without the
cache it would be unavailable offline and the shell would fall back to Natural Earth II.

Only catalog entries with a `tileCache` block (render-core `map-providers.ts`) are cached.
OpenStreetMap has none — its tile policy forbids offline use and bulk fetching. The route is
not a proxy: it takes a catalog source id and three range-checked integers, and builds the
upstream URL from the catalog's template. A development build loads the page over http from
Vite, has no such route, and fetches tiles directly.

### Render budget

How much of each rule a machine gets is measured, not assumed
(`render-core/src/performance.ts`). Each renderer reports a `frame` event carrying the frame
rate it achieved while drawing and the feature count it achieved it with;
`PerformanceGovernor` turns that into a rung on a fixed ladder of `{ detail, maxFeatures }`
pairs, each strictly cheaper than the one above it. Two slow seconds step down, six fast
ones step back up, and a rung that has had to be abandoned costs more fast seconds to climb
back into each time.

| Detail | Meaning                                               |
| ------ | ----------------------------------------------------- |
| 0      | Full — every rule's authored mode for the band.       |
| 1      | Reduced — icons become markers (no sprite, no label). |
| 2      | Minimal — icons and markers become bare points.       |

No level groups, hides or aggregates anything: a slow machine gets cheaper dots, never
fewer. The feature cap only comes down after all the detail has gone, and its floor
(50,000) sits far above any real world state. The governor only steps onto a rung that would
change what is drawn — a rung that merely lowers a cap the view is nowhere near does nothing.

MapLibre renders on demand, so its frame rate is measured over rendering time only: an idle
map is not a slow map. (It used to divide by wall-clock time, so a map left alone for thirty
seconds reported 0.03 fps and the governor stepped detail down on a machine doing nothing.)
Gaps under half a second still count as frames, so input that arrives in discrete steps a
tenth of a second apart — what desktop automation produces, not a hand on a mouse — reads as
10–40 fps with 400 ms "frames" while no task is long. Measure 2D with continuous motion
(a held arrow key pans continuously): on the operator's machine that read ~167 fps with a
worst frame of 28 ms, satellite refresh included.

The desktop shell prints one `[perf]` line every ten seconds — frame rate, feature count,
presentation passes and their cost, band and budget — which the main process keeps in the
application log as `renderer perf` (category `renderer`). Two fields exist because frame
rate hides hitches: `frameMaxMs`, the longest gap between two drawn frames (a 150 ms stall
costs a second only ~8 of its 60 frames), and `longTasks`/`longTaskMaxMs`, main-thread tasks
of 50 ms or more from the Long Tasks API, whoever ran them — React re-rendering the shell
included.

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

Esri World Imagery is addressed as a tile tree rather than through
`ArcGisMapServerImageryProvider.fromUrl`, which cannot produce a provider without first
fetching the service document (`?f=json`). Nothing in that document is needed to address
a tile, and making it a precondition gave the only deep basemap in the build a failure
mode that has nothing to do with imagery: one refused metadata request and the stack fell
back to Natural Earth II's three levels. A tile template is synchronous, so the only thing
left that can fail is a tile — which `tileFailureFallback` already covers. When a fallback
does happen, the message carries whatever the provider actually threw, because "Esri World
Imagery is unavailable" on its own is indistinguishable between a 403, a CORS refusal and
a DNS failure.

| Stack id             | Source                                                                                                               | Credentials                         | Legal review                      | Default                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------- | --------------------------------- |
| `natural-earth`      | Cesium's bundled Natural Earth II (`buildModuleUrl('Assets/Textures/NaturalEarthII')`) on `EllipsoidTerrainProvider` | none, no network                    | approved                          | **yes** (also the recovery stack) |
| `esri-world-imagery` | World_Imagery `/tile/{z}/{y}/{x}` via `UrlTemplateImageryProvider`, max level 19                                     | none                                | conditional (C-1)                 | no                                |
| `osm-raster`         | `OpenStreetMapImageryProvider` tile.openstreetmap.org                                                                | none                                | conditional (E-9) — never default | no                                |
| `cesium-ion-bing`    | `IonImageryProvider` asset 3                                                                                         | user's ion token                    | conditional (C-8)                 | no                                |
| `google-3d`          | `createGooglePhotorealistic3DTileset`                                                                                | user's key via `credentialRef` only | conditional (C-9 / E-8)           | no                                |
| `raster-xyz:<id>`    | `UrlTemplateImageryProvider` from a `raster-xyz` descriptor                                                          | none                                | approved unless OSM host          | no                                |
| `none`               | bare globe with the dark base colour                                                                                 | none                                | approved                          | no                                |

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

## Borders and place names (reference layer)

Faint country and state/province borders and their names are drawn under the world's own
objects on every basemap, including none, and offline. The data is Natural Earth (public
domain), bundled in `apps/desktop/assets/reference/` and built reproducibly:

```
node tools/dev/reference-data/download.mjs <raw-dir>    # on a machine with network access
node tools/dev/reference-data/build.mjs <raw-dir>       # writes apps/desktop/assets
```

`download.mjs` records every file's SHA-256; `build.mjs` refuses input that does not match.
Lines are simplified (Douglas-Peucker, 0.002° countries / 0.004° states) and quantised to
1/1000° — inside Natural Earth 10m's own accuracy — then delta-encoded: 2.4 MB for 7,910
country and 44,440 state lines. Labels are Natural Earth's label points with its own zoom
ranges (`MIN_LABEL`/`MAX_LABEL`, 256-px web zoom — the convention `ViewState.zoom` uses).

Natural Earth files some real state borders under "statistical" classes (California–Nevada,
Texas–New Mexico and 46 more in the US), so every admin-1 line class is kept except the
unnamed maritime indicators.

- **3D.** Borders are a transparent imagery layer whose 256-px tiles are drawn on demand
  (`render-cesium/reference-tiles.ts`): draped by the globe over any terrain, no depth
  fighting, and only the tiles in view cost anything. Names are a `LabelCollection` shown by
  zoom range and hidden behind the Earth by the markers' horizon test, not depth-tested.
- **2D.** Two GeoJSON sources with line and symbol layers inserted beneath the first overlay
  layer (`render-maplibre/reference.ts`); MapLibre's collision detection keeps names apart.
  Every 2D style carries the bundled glyphs (`apps/desktop/assets/fonts`, Noto Sans Regular,
  OFL); glyph ranges the app does not bundle are answered empty, not 404.

Settings → Rendering has a switch for each (`settings.reference`, migration 005).

## Dense layers and benchmarks

`@worldview/render-dense` defines `DenseLayerRenderer` and the `NativeDenseAdapter`
that replaces a layer wholesale on the active renderer within a `DenseBudget` (per-band
caps, priority-ordered, scalable under low power). deck.gl is added only if
`tools/benchmark` shows the native adapters missing the 30 FPS heavy-region target.

`pnpm benchmark` runs the CPU-side harness (`render-dense/src/benchmark.ts`) and writes
`artifacts/verification/benchmarks/presentation.json`. It reports three medians per
case — `present` (building the frame), `diff` (comparing it with the last one) and
`frame` (both together, which is what a renderer tick actually costs) — at
1k / 10k / 50k / 100k synthetic objects across the global / regional / local bands.

Measured on the build container (Node 22, x64, 9 iterations; a shared container, so
these are indicative rather than a hardware figure):

| Objects | Band     | present |    diff |   frame | features |
| ------: | -------- | ------: | ------: | ------: | -------: |
|     10k | local    |  0.6 ms |  0.8 ms |  1.4 ms |    1,429 |
|     50k | local    |  3.4 ms |  5.7 ms |  9.0 ms |    7,143 |
|    100k | local    |  7.8 ms | 15.5 ms | 38.3 ms |   14,286 |
|    100k | regional |  7.9 ms |  1.2 ms |  8.4 ms |    1,521 |
|    100k | global   | 16.5 ms | 37.0 ms | 54.0 ms |   28,596 |

`diffFeatures` used to serialise both sides with `JSON.stringify`; it now compares
fields structurally, indexes the new frame in the same pass (the host reuses that index
instead of rebuilding it), and skips the removal scan entirely when every previous id
survived — the steady state while objects move. Isolated, the diff of a 28.6k-feature
frame takes ≈9 ms; the larger number in the table is the same work under the allocation
pressure of having just built 28.6k fresh feature objects.

That allocation is now the real cost, not the comparison: presentation rebuilds every
visible feature each tick. The next optimisation is incremental presentation (reusing
feature objects for unchanged world objects), which is a design change rather than a
tweak, and it is not needed for Release 1 — the renderer caps features at
`maxFeatures`, and presentation moves to a worker above 5,000 objects, so the UI thread
is not the one paying.

**What the headline figure means.** `frameBudgetObjectsLocal` is the largest local-zoom
set whose _whole_ in-thread update — present and diff together — fits in one 60 FPS
frame, which is 50k here. It used to be derived from the `present` median alone, which
reported 100k and was an overstatement of roughly the diff cost; the measurement now
matches what the main thread actually does. Above that, and for the 100k global case,
the work belongs in the worker — which is what the 5,000-object threshold is for.

### Satellites between polls in 2D: tried, measured, not shipped

On the globe a satellite moves continuously between its two SGP4 positions
(RenderFeature.motion, render-cesium `layers/motion.ts`). The 2D map still steps every 15 s.
Doing the same in MapLibre by moving the points in their GeoJSON source was built and
measured on the operator machine (2026-09-23, `f480218`, reverted): every step — even a few
hundred points in a regional view — makes MapLibre re-index the whole 16.5k-point satellite
source in its worker and reload every tile in view, and the map sat at ~20–22 fps with
200–300 ms gaps between frames for as long as the timeline was live, with no long task on
the main thread to show for it. Smooth 2D motion needs positions that change without a
source re-index: a custom WebGL layer (MapLibre `CustomLayerInterface`) or deck.gl's
ScatterplotLayer for the satellites. Neither exists yet.

### Moving markers: satellites, aircraft and ships (2026-09-23)

`RenderFeature.motion` now carries two kinds of move. A satellite's is two SGP4 propagations,
as before. An aircraft's or ship's is dead reckoned (render-core `motion.ts`): its last report,
and where the reported ground speed and track carry it 30 s on (a ship: 60 s), climbing at the
reported vertical rate. Renderers carry a marker at most `MOTION_MAX_T` (2) spans past its
first end and hold it there, so an aircraft is never drawn more than a minute ahead of its
report. Nothing is dead reckoned on the ground (taxiways turn), below 5 m/s (a ship: 0.5), or
faster than Mach 3 (a bad report). Only while the timeline is live, as for satellites.

On the globe the Cesium `Movers` place them by wall-clock time, as they did satellites; the
step is now paced by the fastest marker registered (`Movers.maxSpeedMps`), so aircraft alone
are stepped about thirty times as seldom as satellites for the same half pixel.

In 2D the lesson above is kept rather than fought: the markers that move are taken out of
their layer's source (`SourceModel.hold`) and drawn from a companion source of their own,
`wv:<layer>~moving`, which is the only source replaced each step — so a step re-indexes the
few hundred markers in it, not the 16.5k satellites or the tens of thousands of aircraft in
the layer. What moves is chosen again when the view settles (never mid-gesture, since every
change to the set is a diff to the big source): markers inside the view and a quarter of its
size around it, at most 1,500 (`MAX_MOVING_2D`). A view holding more than that is zoomed out
far enough that a step is under a pixel for a long time, and nothing there moves. A marker
that stops moving goes back to its layer where it had got to, not to its report. Steps come
as often as the fastest moving marker covers half a pixel at the zoom, 30 a second at most
and one every two seconds at least (`motionStepMs2d`). The satellites' 20 fps is the number
to beat when this is measured on the operator machine.

Measuring it (2026-09-23, operator machine, regional view over London): the 2D map drew at
9 "fps" with 248 ms "frames" while aircraft moved — and the frames themselves took ~2 ms
(`engineMaxMs`, no long tasks). MapLibre draws on demand, so with markers stepping every
250 ms it drew once a step and waited; the frame counter, which already treats a gap over
500 ms as idle, counted those waits as slow frames. While motion is stepping a gap of most of
a step is now a wait too (`idleGapMs`), so the governor is not told a map that is waiting is a
map that is struggling. The same artefact may be what made the reverted satellite attempt
read 20–22 fps.

### Budgets enforced in CI (roadmap 1.0)

`pnpm perf:budget` (tools/perf-budget) runs the same harness and the SQLite place index at
100,000 places, and fails when a median passes its ceiling in `config/perf-budgets.json`;
CI runs it as the `perf-budget` job and keeps `artifacts/verification/perf-budget.json`.
The first budget is the product one — a local-zoom update of 10,000 objects inside one
60 fps frame (16.7 ms); the others are regression ceilings about three times what the build
container measured when they were set (2026-09-23: 10k local 4.4 ms, 50k local 18.7 ms,
50k global 89.9 ms; 100k places built in 1.2 s, searched in ~12 ms). A ceiling is raised
only with the reason in the commit. GPU frame time is not a CI measurement — it is read on
the operator machine from the `renderer perf` log lines.

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

## How the renderers reach the application

`apps/desktop/src/renderer/renderer-host.ts` (`DesktopRendererHost`) owns both adapters
and is what `main.tsx` installs in Electron. It mounts one renderer at a time into its
own pane, and holds the state a mode switch has to carry across: features, view,
selection, basemap per mode, terrain and attribution. Both libraries are imported
lazily, so a session that never leaves 2D never constructs a Cesium viewer or pays for
its WebGL context.

It exists because `RendererHost` in render-core and the shell were built to different
shapes — `RendererHost` presents a world snapshot itself, while the shell runs the
presentation pipeline and pushes a `FeatureUpdate` — and the two were never joined.
Until this adapter, `resolveHost()` fell through to the demo canvas host in _every_
build, including packaged ones: the Cesium and MapLibre adapters were written, tested and
never composed, so WORLDVIEW shipped with neither of its map renderers. The
`window.worldviewHost` hook remains as an override for a host supplied from outside; it
is no longer what production depends on.

A renderer that fails to construct is reported through the host's `error` event and the
mode does _not_ change: claiming 3D while showing nothing is worse than staying in 2D.
