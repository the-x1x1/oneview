/**
 * Long animation frames (Chromium's Long Animation Frames API), attributed.
 *
 * The Long Tasks API says a task took 155 ms; it does not say what ran. Every long task in
 * the perf log that did not contain a world delta was "other" — the 2D map at continental
 * zoom had five to seven of them per window, up to 156 ms, and nothing to go on. A long
 * animation frame names the scripts that ran in it: the entry point that called them
 * (a requestAnimationFrame callback, a promise resolution, an event listener), the bundle
 * chunk they are in (the app, the MapLibre chunk, the Cesium chunk) and where in it, and
 * how much of the frame went to style and layout rather than script. That is enough to say
 * whether a hitch is ours, React's, or the map engine's.
 *
 * Only the chunk's name, the entry point's kind and numbers leave this module — no URLs.
 */

/** The parts of a PerformanceLongAnimationFrameTiming this reads (typed here; lib.dom may lag). */
export interface LongFrameEntryLike {
  startTime: number;
  duration: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: ReadonlyArray<{
    duration: number;
    invokerType?: string;
    invoker?: string;
    sourceURL?: string;
    sourceFunctionName?: string;
    sourceCharPosition?: number;
    forcedStyleAndLayoutDuration?: number;
  }>;
}

export interface LongFrameSummary {
  durationMs: number;
  /** Time in script, all scripts together. */
  scriptMs: number;
  /** Style and layout: the frame's own pass plus layout forced by scripts. */
  layoutMs: number;
  /** The longest script: `<chunk>:<entry kind>` and its duration, at most 40 characters. */
  top: string;
  /** Where in its chunk the longest script starts (for the source map), or -1. */
  topPos: number;
}

const INVOKER: Record<string, string> = {
  'user-callback': 'callback',
  'event-listener': 'event',
  'resolve-promise': 'promise',
  'reject-promise': 'promise-reject',
  'classic-script': 'script',
  'module-script': 'module',
};

/** `https://…/assets/maplibre-Cx81.js` → `maplibre`; the app's own entry → `index`. */
export function chunkName(url: string | undefined): string {
  if (!url) return 'unknown';
  const file = url.split(/[?#]/)[0]!.split('/').pop() ?? '';
  const stem = file.replace(/\.m?js$/, '').replace(/-[A-Za-z0-9_]{6,}$/, '');
  return (stem || 'unknown').slice(0, 20);
}

export function summariseLongFrame(entry: LongFrameEntryLike): LongFrameSummary {
  const scripts = entry.scripts ?? [];
  let scriptMs = 0;
  let forced = 0;
  let top: (typeof scripts)[number] | undefined;
  for (const s of scripts) {
    scriptMs += s.duration;
    forced += s.forcedStyleAndLayoutDuration ?? 0;
    if (!top || s.duration > top.duration) top = s;
  }
  const end = entry.startTime + entry.duration;
  const frameLayout = entry.styleAndLayoutStart && entry.styleAndLayoutStart > 0 ? end - entry.styleAndLayoutStart : 0;
  const label = top
    ? `${chunkName(top.sourceURL)}:${INVOKER[top.invokerType ?? ''] ?? 'other'} ${Math.round(top.duration)}ms`
    : 'no-script';
  return {
    durationMs: entry.duration,
    scriptMs,
    layoutMs: Math.max(0, frameLayout) + forced,
    top: label.slice(0, 40),
    topPos: top?.sourceCharPosition ?? -1,
  };
}

/** Frames of 50 ms or more, summarised. A no-op where the API is missing (tests, older engines). */
export function observeLongFrames(onFrame: (frame: LongFrameSummary) => void): () => void {
  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
  )
    return () => undefined;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) onFrame(summariseLongFrame(entry as unknown as LongFrameEntryLike));
  });
  observer.observe({ type: 'long-animation-frame', buffered: false });
  return () => observer.disconnect();
}
