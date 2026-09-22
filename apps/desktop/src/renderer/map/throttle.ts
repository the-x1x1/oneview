/**
 * Call `fn` with the most recent value at most once per `intervalMs`, always delivering the
 * last value of a burst.
 *
 * Built for camera motion. Both renderers report a view change on nearly every frame while
 * the camera moves (Cesium's `percentageChanged` is 1 %, MapLibre fires on `move`), and the
 * shell used to put each one into application state — so every frame of a pan re-rendered
 * the whole shell and re-ran presentation over every object on the main thread. Nothing that
 * reads the view needs it sixty times a second; everything that reads it needs the *last*
 * one, which is why the trailing call is not optional.
 */
export interface Throttled<T> {
  call(value: T): void;
  /** Deliver a pending value now, if there is one. */
  flush(): void;
  /** Drop a pending value and stop the timer. */
  cancel(): void;
}

export interface ThrottleClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function throttleLatest<T>(
  intervalMs: number,
  fn: (value: T) => void,
  clock: ThrottleClock = realClock,
): Throttled<T> {
  let last = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let pending: { value: T } | null = null;
  const run = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    const p = pending;
    pending = null;
    if (!p) return;
    last = clock.now();
    fn(p.value);
  };
  return {
    call(value) {
      pending = { value };
      if (timer !== null) return;
      const wait = intervalMs - (clock.now() - last);
      if (wait <= 0) run();
      else timer = clock.setTimeout(run, wait);
    },
    flush: run,
    cancel() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
