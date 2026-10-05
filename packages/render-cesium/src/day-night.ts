import { DAY_NIGHT_REFRESH_MS } from '@worldview/render-core';
import type { CesiumLike, JulianDateLike, ViewerLike } from './cesium-like.js';

export interface DayNightTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * Day and night on the globe: Cesium's own lighting, from the real Sun.
 *
 * Cesium already knows where the Sun is for any time on the scene clock, and lights the
 * globe from it once `globe.enableLighting` is on. What it does not do in WORLDVIEW is keep
 * that clock current: the widget's clock does not advance (nothing here animates by
 * simulation time), and the scene is drawn in request-render mode with
 * `maximumRenderTimeChange` infinite, so a changing clock would not draw a frame by itself
 * anyway. So while the shading is on, the clock is set to now once a minute — the terminator
 * moves a quarter of a degree in that time — and one frame is asked for.
 *
 * Cesium fades lighting out as the camera comes closer than a few thousand kilometres (its
 * defaults leave everything below ~3,600 km altitude lit). The 2D map shades the night side
 * at every zoom, so here the fade is moved inside the Earth: the night side is shaded at
 * every altitude, and the two views agree.
 *
 * Ground atmosphere stays off (viewer.ts says why). Turning the shading off puts back the
 * lighting flag, the fade distances and the clock exactly as they were, so the globe looks as
 * it did before it was turned on — the Sun and Moon Cesium draws among the stars included.
 */
export class DayNight3D {
  private saved: { fadeOut: number; fadeIn: number; time: JulianDateLike } | undefined;
  private timer: unknown;
  /** The time lit for (the timeline's, paused or replaying); undefined: now, to the minute. */
  private atMs: number | undefined;

  constructor(
    private readonly cesium: Pick<CesiumLike, 'JulianDate'>,
    private readonly viewer: ViewerLike,
    private readonly wallNow: () => number,
    private readonly timers: DayNightTimers,
  ) {}

  get on(): boolean {
    return this.saved !== undefined;
  }

  /**
   * On or off; lit for `atMs` when given (the timeline's time), else for now, kept current.
   * Only the time changing relights at once.
   */
  set(on: boolean, atMs?: number): void {
    const at = on && atMs !== undefined && Number.isFinite(atMs) ? atMs : undefined;
    if (on === this.on) {
      if (on && at !== this.atMs) {
        this.atMs = at;
        this.keepCurrent();
        this.refresh();
      }
      return;
    }
    this.atMs = at;
    const globe = this.viewer.scene.globe;
    if (on) {
      this.saved = {
        fadeOut: globe.lightingFadeOutDistance,
        fadeIn: globe.lightingFadeInDistance,
        time: this.viewer.clock.currentTime,
      };
      globe.enableLighting = true;
      // Distances from the Earth's centre: every camera is farther out than 2 m, so lighting
      // is always at full strength.
      globe.lightingFadeOutDistance = 1;
      globe.lightingFadeInDistance = 2;
      this.refresh();
      this.keepCurrent();
    } else {
      const saved = this.saved!;
      this.saved = undefined;
      this.keepCurrent();
      globe.enableLighting = false;
      globe.lightingFadeOutDistance = saved.fadeOut;
      globe.lightingFadeInDistance = saved.fadeIn;
      this.viewer.clock.currentTime = saved.time;
      this.viewer.scene.requestRender();
    }
  }

  /** The minute's relighting runs while the shading is on and follows the clock, and only then. */
  private keepCurrent(): void {
    const wanted = this.on && this.atMs === undefined;
    if (wanted && this.timer === undefined)
      this.timer = this.timers.setInterval(() => this.refresh(), DAY_NIGHT_REFRESH_MS);
    else if (!wanted && this.timer !== undefined) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Set the scene clock to now (or the time asked for) and draw one frame lit from where the Sun is. */
  refresh(): void {
    if (!this.on) return;
    this.viewer.clock.currentTime = this.cesium.JulianDate.fromDate(new Date(this.atMs ?? this.wallNow()));
    this.viewer.scene.requestRender();
  }

  dispose(): void {
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }
}
