/**
 * Adapted from gods-eye-view src/app/viewer.js (MIT).
 *
 * Differences from GEV: the globe is SHOWN by default (WORLDVIEW's default 3D
 * stack is Natural Earth II on the ellipsoid; Google 3D is an optional adapter
 * that hides the globe only while it is active), the module surface is injected
 * (`CesiumLike`) and `createWheelEvent` is injectable for tests.
 */
import type { CesiumLike, ViewerLike, ViewerOptionsLike, CameraEventBindingLike } from './cesium-like.js';

export interface CreateViewerOptions {
  container: Element;
  creditContainer: Element;
  /** Cesium's `requestRenderMode` (render only on change). Off by default: moving objects re-render every frame anyway. */
  requestRenderMode?: boolean;
  powerPreference?: 'default' | 'low-power' | 'high-performance';
}

/**
 * GEV's proven widget-free viewer options: no default base layer (WORLDVIEW chooses the
 * stack), msaa 4, and a preserved drawing buffer so screenshots capture the globe.
 *
 * GEV switched Cesium's widget chrome off one flag at a time because it built a `Viewer`.
 * WORLDVIEW builds a `CesiumWidget` instead, which has no chrome to switch off, so the
 * flags are gone rather than set to false.
 */
export function viewerOptions(opts: CreateViewerOptions): ViewerOptionsLike {
  return {
    baseLayer: false,
    creditContainer: opts.creditContainer,
    msaaSamples: 4,
    requestRenderMode: opts.requestRenderMode ?? false,
    contextOptions: {
      webgl: { preserveDrawingBuffer: true, powerPreference: opts.powerPreference ?? 'high-performance' },
    },
  };
}

export function createWorldViewer(cesium: CesiumLike, opts: CreateViewerOptions): ViewerLike {
  const viewer = cesium.createViewer(opts.container, viewerOptions(opts));
  try {
    // No frame-rate cap. GEV set `targetFrameRate = 60`, and on a display faster than 60 Hz
    // that does not give 60 even frames: Cesium draws on the first vsync after 16.7 ms has
    // passed, so at 144 Hz frames alternate 20.8 ms and 13.9 ms, and at 165 Hz they run
    // 18, 18, 18, 18, 12 ms. The average reads 60 and the motion judders — on the operator's
    // machine the 2D map, which has no cap, measured ~158 fps. Uncapped, the globe draws on
    // every vsync the machine can keep up with; the performance governor handles the rest.
    // Draw at the display's own pixel density. Cesium's default renders at CSS pixels and
    // lets the browser stretch the result, which on a scaled display (125–175 % is common
    // on Windows) softened the imagery and turned small dots into blurred blobs. Past 2×
    // the gain is not worth the fill rate, so the scale is capped there.
    viewer.useBrowserRecommendedResolution = false;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    if (dpr > 2) viewer.resolutionScale = 2 / dpr;
    viewer.scene.globe.show = true;
    // Lighting off: WORLDVIEW shows the whole world at once, and a day/night terminator
    // would hide half the data behind a shadow that means nothing to it.
    viewer.scene.globe.enableLighting = false;
    // Ground atmosphere off, because lighting is off. Cesium's ground scattering is
    // computed from a light direction; with `enableLighting` false there isn't one, so it
    // falls back to lighting the whole visible disc at full strength and adds that to
    // every pixel. The result is not subtle — Natural Earth II's deep blue ocean came out
    // pale cyan and its land came out white, with continents readable only by outline.
    // The basemap is something operators read values off, so its colours have to survive
    // the trip to the screen. The limb glow people actually want from "atmosphere" comes
    // from skyAtmosphere below, which is unaffected by any of this and stays on.
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.globe.baseColor = new cesium.Color(0.06, 0.08, 0.11, 1);
    viewer.scene.backgroundColor = new cesium.Color(0.02, 0.03, 0.05, 1);
    // Cesium builds a Viewer without a sky atmosphere in some configurations, and its
    // own types say so. Writing through it unconditionally was a TypeError waiting for
    // one of those; the globe is perfectly usable without the atmosphere tuning.
    const sky = viewer.scene.skyAtmosphere;
    if (sky) {
      sky.show = true;
      sky.atmosphereLightIntensity = 18;
      sky.saturationShift = -0.12;
      sky.brightnessShift = -0.08;
    }
    // Keep what has been fetched. Cesium keeps 100 tiles beyond those in view; with Esri
    // imagery reaching level 19, a pan across a city and back evicts the tiles it just
    // loaded and fetches them again, which reads as the map "buffering" over ground it has
    // already shown. Four hundred is a few hundred megabytes of GPU memory at worst.
    viewer.scene.globe.tileCacheSize = 400;
    // And fetch the neighbours of what is drawn, so the edge revealed by a pan is usually
    // already there instead of arriving a moment after it comes into view.
    viewer.scene.globe.preloadSiblings = true;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 30;
    return viewer;
  } catch (error) {
    viewer.destroy();
    throw error;
  }
}

const PINCH_ZOOM_MULTIPLIER = 8;
const MAX_PINCH_PIXEL_DELTA = 120;

/** Browsers deliver trackpad pinch as a tiny Ctrl+wheel; amplify it (×8, capped at 120 px) so Cesium zooms at a usable rate. */
export function boundedPinchDelta(delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return delta;
  return Math.sign(delta) * Math.min(Math.abs(delta) * PINCH_ZOOM_MULTIPLIER, MAX_PINCH_PIXEL_DELTA);
}

export interface WheelEventLike {
  ctrlKey: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  screenX: number;
  screenY: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
  stopPropagation(): void;
}
export interface WheelEventInitLike {
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  deltaMode: number;
  screenX: number;
  screenY: number;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  bubbles: boolean;
  cancelable: boolean;
}
export interface PinchZoomTarget {
  scene: {
    screenSpaceCameraController: {
      zoomEventTypes: number | CameraEventBindingLike | Array<number | CameraEventBindingLike> | undefined;
    };
  };
  container: {
    addEventListener(
      type: 'wheel',
      listener: (e: WheelEventLike) => void,
      options?: { capture?: boolean; passive?: boolean },
    ): void;
    removeEventListener(type: 'wheel', listener: (e: WheelEventLike) => void, capture?: boolean): void;
  };
  canvas: { dispatchEvent(event: object): boolean };
}

/**
 * Add browser trackpad pinch to Cesium's zoom inputs and return its disposer.
 * The relayed event is marked so it is not amplified twice.
 */
export function installTrackpadPinchZoom(
  cesium: Pick<CesiumLike, 'CameraEventType' | 'KeyboardEventModifier'>,
  viewer: PinchZoomTarget,
  createWheelEvent: (type: 'wheel', init: WheelEventInitLike) => object = (type, init) => new WheelEvent(type, init),
): () => void {
  const controller = viewer.scene.screenSpaceCameraController;
  const original = controller.zoomEventTypes;
  const list: Array<number | CameraEventBindingLike> = Array.isArray(original)
    ? original
    : original === undefined
      ? []
      : [original];
  const ctrlWheel: CameraEventBindingLike = {
    eventType: cesium.CameraEventType.WHEEL,
    modifier: cesium.KeyboardEventModifier.CTRL,
  };
  const alreadyHandles = list.some(
    (b) => typeof b === 'object' && b.eventType === ctrlWheel.eventType && b.modifier === ctrlWheel.modifier,
  );
  const configured = alreadyHandles ? original : [...list, ctrlWheel];
  if (!alreadyHandles) controller.zoomEventTypes = configured;

  const relayed = new WeakSet<object>();
  const relayPinch = (event: WheelEventLike): void => {
    if (
      !event.ctrlKey ||
      relayed.has(event) ||
      event.deltaMode !== 0 ||
      !Number.isFinite(event.deltaY) ||
      event.deltaY === 0
    )
      return;
    let synthetic: object;
    try {
      synthetic = createWheelEvent('wheel', {
        deltaX: event.deltaX,
        deltaY: boundedPinchDelta(event.deltaY),
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
    } catch {
      return; // The registered Ctrl+wheel binding still consumes the original event.
    }
    relayed.add(synthetic);
    event.preventDefault();
    event.stopPropagation();
    viewer.canvas.dispatchEvent(synthetic);
  };
  viewer.container.addEventListener('wheel', relayPinch, { capture: true, passive: false });

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    viewer.container.removeEventListener('wheel', relayPinch, true);
    if (!alreadyHandles && controller.zoomEventTypes === configured) controller.zoomEventTypes = original;
  };
}
