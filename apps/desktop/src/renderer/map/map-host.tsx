import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadReferenceData } from './reference-data.js';
import type { GeoBounds } from '@worldview/world-model';
import type { WorldSubscription } from '@worldview/ipc-contract';
import type { BasemapDescriptor, ReferenceData, TerrainDescriptor } from '@worldview/render-core';
import {
  diffFeatures,
  lensById,
  lodBand,
  PerformanceGovernor,
  presentObjects,
  restyleHover,
  type PerformanceBudget,
  type RenderFeature,
  type ViewState,
} from '@worldview/render-core';
import { Button, EmptyState, Icon } from '@worldview/ui';
import { useActions, useAppState, useClient, useDispatch, useHosts } from '../store/store.js';
import { basemapForMode, terrainFor } from '../map-providers.js';
import { BasemapNotice } from './basemap-notice.js';
import { gpuRenderer } from './gpu-info.js';
import { describeError } from '../store/sync.js';
import { throttleLatest, type Throttled } from './throttle.js';
import { FeatureFeed } from './feature-feed.js';
import { attributeLongTask, markDelta, takeDecodeMax } from './delta-marks.js';
import { nextSubscriptionBounds, pinnedSelection } from './subscription-bounds.js';
import { lensFilter } from '../overview-layers.js';

const VIEWPORT_THROTTLE_MS = 500;
const PERF_WINDOW_MS = 10_000;

interface PerfWindow {
  startedAt: number;
  fps: number[];
  features: number;
  /** Presentation passes: `presentObjects` plus the diff, on the main thread. */
  passes: number;
  presentMs: number;
  presentMaxMs: number;
  changed: number;
  /** Frames that handed a slice of changes to the renderer, and the dearest of them. */
  applyFrames: number;
  applyMaxMs: number;
  backlogMax: number;
  /** Longest gap between two frames the renderer drew: the hitch that fps averages away. */
  frameMaxMs: number;
  /** Longest hand-over of feature data to the engine (2D: MapLibre setData/updateData). */
  pushMaxMs: number;
  /** Main-thread tasks over 50 ms (Long Tasks API), whatever ran them — React included. */
  longTasks: number;
  longTaskMaxMs: number;
  /** The longest of those that contained a world delta's arrival (delta-marks.ts)… */
  deltaTaskMaxMs: number;
  /** …how much of it came before the handler ran — receiving the message — … */
  deltaReceiveMs: number;
  /** …and how many objects that delta carried. */
  deltaObjects: number;
  /** The longest `JSON.parse` of an event sent as JSON (wire-client.ts). */
  deltaParseMs: number;
  /** World subscriptions answered — each a full snapshot that replaces the mirror — and the largest. */
  subscribes: number;
  snapshotMax: number;
}

function newPerfWindow(now = typeof performance !== 'undefined' ? performance.now() : Date.now()): PerfWindow {
  return {
    startedAt: now,
    fps: [],
    features: 0,
    passes: 0,
    presentMs: 0,
    presentMaxMs: 0,
    changed: 0,
    applyFrames: 0,
    applyMaxMs: 0,
    backlogMax: 0,
    frameMaxMs: 0,
    pushMaxMs: 0,
    longTasks: 0,
    longTaskMaxMs: 0,
    deltaTaskMaxMs: 0,
    deltaReceiveMs: 0,
    deltaObjects: 0,
    deltaParseMs: 0,
    subscribes: 0,
    snapshotMax: 0,
  };
}

/** One flat record: what the watchdog accepts, and what a person can read in the log. */
export function summarisePerf(
  w: PerfWindow,
  mode: '2D' | '3D',
  budget: PerformanceBudget,
  band: string,
): Record<string, number | string> {
  const fps = w.fps.length ? w.fps : [0];
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    mode,
    band,
    fpsMin: Math.min(...fps),
    fpsAvg: round(fps.reduce((a, b) => a + b, 0) / fps.length),
    frameMaxMs: Math.round(w.frameMaxMs),
    pushMaxMs: round(w.pushMaxMs),
    longTasks: w.longTasks,
    longTaskMaxMs: Math.round(w.longTaskMaxMs),
    deltaTaskMaxMs: Math.round(w.deltaTaskMaxMs),
    deltaReceiveMs: Math.round(w.deltaReceiveMs),
    deltaObjects: w.deltaObjects,
    deltaParseMs: round(w.deltaParseMs),
    subscribes: w.subscribes,
    snapshotMax: w.snapshotMax,
    features: w.features,
    passes: w.passes,
    presentAvgMs: round(w.passes ? w.presentMs / w.passes : 0),
    presentMaxMs: round(w.presentMaxMs),
    changed: w.changed,
    applyFrames: w.applyFrames,
    applyMaxMs: round(w.applyMaxMs),
    backlogMax: w.backlogMax,
    detail: budget.detail,
    maxFeatures: budget.maxFeatures,
  };
}

/** How long the camera must stay still before the next zoom levels are fetched ahead. */
const PREFETCH_SETTLE_MS = 700;

/** How often camera motion reaches application state (and so the shell's render). */
const VIEW_STATE_THROTTLE_MS = 250;

/**
 * Main-thread tasks of 50 ms or more, as Chromium reports them. A frame counter only sees the
 * frames that were drawn; this sees what held them up, whether presentation, a renderer
 * update, React re-rendering the shell, or anything else on the thread. A no-op where the
 * API is missing (tests, static renders).
 */
function observeLongTasks(onTask: (task: { startTime: number; duration: number }) => void): () => void {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask'))
    return () => undefined;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) onTask(entry);
  });
  observer.observe({ type: 'longtask' });
  return () => observer.disconnect();
}

function boundsText(b: GeoBounds): string {
  return [b.west, b.south, b.east, b.north].map((v) => v.toFixed(4)).join(',');
}

/** One animation frame from now (a 16 ms timer where there is none — tests, static renders). */
function nextFrame(cb: (t: number) => void): number {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : (setTimeout(() => cb(0), 16) as unknown as number);
}

/**
 * Centre map host (directive §53): mounts the injected RendererHostLike, turns picks
 * into selection, throttles viewport → world.viewport and keeps the world.subscribe
 * bounds/types/pins in step, and runs the presentation pipeline on the object mirror
 * (features pushed at animation-frame cadence via diffFeatures).
 */
export function MapHost() {
  const { world, lenses, ui, session, sources } = useAppState();
  const actions = useActions();
  const client = useClient();
  const dispatch = useDispatch();
  const hosts = useHosts();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState<'pending' | 'ready' | 'missing' | 'error'>('pending');
  const [errorText, setErrorText] = useState<string | null>(null);
  const previousFeatures = useRef(new Map<string, RenderFeature>());
  /** The bounds the world subscription was last keyed on (subscription-bounds.ts). */
  const subscribedBounds = useRef<GeoBounds | undefined>(undefined);
  /** The hover target `previousFeatures` was presented (or since restyled) with. */
  const hoverShown = useRef<string | null>(null);
  /** Changes waiting to be handed to the renderer, a frame-budgeted slice at a time. */
  const feed = useRef<FeatureFeed | null>(null);
  const drainFrame = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const throttles = useRef<Array<Throttled<ViewState>>>([]);
  /**
   * How much this machine can actually draw, measured rather than assumed. The
   * presentation pass below used to be handed a flat 20,000-feature cap, which is both
   * more than a thin laptop can composite and far less than the operator asked to see on
   * anything newer. The governor walks a ladder from the frame rate the active renderer
   * reports (see render-core/performance.ts); `budget` is state rather than a ref because
   * a new budget has to trigger a presentation pass to mean anything.
   */
  const governor = useRef<PerformanceGovernor | null>(null);
  governor.current ??= new PerformanceGovernor();
  const [budget, setBudget] = useState<PerformanceBudget>(() => governor.current!.budget);
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  /**
   * A running summary printed as one `[perf]` line every ten seconds, which the main
   * process keeps in the application log (renderer-watchdog.ts). A screenshot shows a
   * frame, not a frame rate, and "it is faster now" is a claim that has to come with a number.
   */
  const perf = useRef(newPerfWindow());

  const lens = lensById(lenses.activeId, lenses.lenses);
  const host = hosts.get();
  const supports3D = ui.supports3D;

  // ---- mount host + wire events ----
  useEffect(() => {
    const el = containerRef.current;
    const h = hosts.get();
    if (!el) return;
    if (!h) {
      setMounted('missing');
      dispatch({ type: 'ui/hostCapabilities', supports3D: false });
      return;
    }
    dispatch({ type: 'ui/hostCapabilities', supports3D: h.supportsMode ? h.supportsMode('3D') : true });
    let disposed = false;
    const offs: Array<() => void> = [];
    // Diagnostics shows what the page draws with; the runtime cannot know it any other way.
    const reportRenderer = (fps?: number) => {
      if (disposed) return;
      const gpu = gpuRenderer();
      client
        .request('diagnostics.renderer', {
          active: h.activeMode(),
          webgl2: h.supportsMode ? h.supportsMode('3D') : true,
          ...(gpu ? { gpu } : {}),
          ...(fps !== undefined && Number.isFinite(fps) ? { fps: Math.round(fps) } : {}),
        })
        .catch(() => undefined);
    };
    reportRenderer();
    offs.push(h.on('modeChanged', () => reportRenderer()));
    offs.push(
      observeLongTasks((task) => {
        const w = perf.current;
        w.longTasks++;
        w.longTaskMaxMs = Math.max(w.longTaskMaxMs, task.duration);
        const cause = attributeLongTask(task);
        if (cause.kind === 'delta' && task.duration > w.deltaTaskMaxMs) {
          w.deltaTaskMaxMs = task.duration;
          w.deltaReceiveMs = cause.receiveMs;
          w.deltaObjects = cause.objects;
        }
      }),
    );
    // Both renderers report a view change on nearly every frame of camera motion. That used
    // to go straight into application state, so a pan re-rendered the whole shell and re-ran
    // presentation over every object, sixty times a second, on the thread that also has to
    // draw the map. Nothing that reads the view needs it that often; everything that reads
    // it needs the last one, which `throttleLatest` always delivers.
    const viewState = throttleLatest<ViewState>(VIEW_STATE_THROTTLE_MS, (view) => {
      if (!disposed) dispatch({ type: 'world/view', view });
    });
    const viewportIpc = throttleLatest<ViewState>(VIEWPORT_THROTTLE_MS, (v) => {
      if (disposed || !v.bounds) return;
      client
        .request('world.viewport', { bounds: v.bounds, zoom: v.zoom })
        .catch((err: unknown) => console.warn('[worldview] world.viewport failed:', describeError(err)));
    });
    throttles.current = [viewState, viewportIpc];
    const sendViewport = (view: ViewState) => {
      viewState.call(view);
      viewportIpc.call(view);
    };
    offs.push(h.on('viewChanged', sendViewport));
    offs.push(
      h.on('pick', (pick) => {
        if (!pick) {
          void actions.select(null);
          return;
        }
        if (pick.objectId) void actions.select(pick.objectId, { kind: 'object' });
        else if (pick.eventId) void actions.select(pick.eventId, { kind: 'event' });
        else if (pick.featureId.startsWith('cluster:'))
          void h.flyTo({ position: pick.position, zoom: Math.min(16, h.getView().zoom + 2) });
      }),
    );
    offs.push(h.on('hover', (hit) => actions.hover(hit?.objectId ?? null)));
    // The only honest source of the active mode: the host says so once the renderer for
    // it is actually up.
    const syncCeiling = () => governor.current!.setFeatureCeiling(h.maxFeatures?.() ?? Number.POSITIVE_INFINITY);
    offs.push(
      h.on('modeChanged', ({ mode }) => {
        dispatch({ type: 'ui/activeMode', mode });
        // The two renderers do not have the same ceiling, and frames measured against the
        // one being left say nothing about the one arriving.
        syncCeiling();
        governor.current!.resetRuns();
        setBudget(governor.current!.budget);
      }),
    );
    offs.push(
      h.on('frame', (sample) => {
        // A hidden or fully covered window is throttled by Chromium to a frame every so
        // often. That is not a slow machine, and feeding it to the governor would degrade
        // the map for being in the background.
        if (typeof document !== 'undefined' && document.hidden) return;
        const w = perf.current;
        w.fps.push(sample.fps);
        w.features = sample.featureCount;
        w.frameMaxMs = Math.max(w.frameMaxMs, sample.maxFrameMs ?? 0);
        w.pushMaxMs = Math.max(w.pushMaxMs, sample.pushMaxMs ?? 0);
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - w.startedAt >= PERF_WINDOW_MS) {
          w.deltaParseMs = takeDecodeMax();
          const summary = summarisePerf(w, h.activeMode(), budgetRef.current, bandRef.current);
          console.info(`[perf] ${JSON.stringify(summary)}`);
          reportRenderer(typeof summary.fpsAvg === 'number' ? summary.fpsAvg : undefined);
          perf.current = newPerfWindow(now);
        }
        if (!governor.current!.sample(sample)) return;
        setBudget(governor.current!.budget);
      }),
    );
    offs.push(
      h.on('error', ({ message, fatal }) => {
        if (fatal) {
          setMounted('error');
          setErrorText(message);
        } else {
          // Also to the console, which the main process captures into the application
          // log (main/renderer-watchdog.ts). A toast is the right place to tell someone
          // now; it is the wrong place to leave the only copy, because it disappears and
          // a non-fatal renderer problem — a basemap that quietly fell back, say — is
          // exactly the kind of thing you go looking for afterwards.
          console.warn('[renderer] %s', message);
          actions.notify('Renderer', message, 'MINOR');
        }
      }),
    );
    offs.push(
      h.on('ready', () => {
        if (!disposed) {
          setMounted('ready');
          dispatch({ type: 'ui/activeMode', mode: h.activeMode() });
          syncCeiling();
          sendViewport(h.getView());
        }
      }),
    );
    Promise.resolve(h.mount(el))
      .then(() => {
        if (!disposed) {
          setMounted('ready');
          dispatch({ type: 'ui/activeMode', mode: h.activeMode() });
          syncCeiling();
          sendViewport(h.getView());
        }
      })
      .catch((err: unknown) => {
        setMounted('error');
        setErrorText(describeError(err));
      });
    return () => {
      disposed = true;
      for (const off of offs) off();
      for (const t of throttles.current) t.cancel();
      throttles.current = [];
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (drainFrame.current !== null) cancelAnimationFrame(drainFrame.current);
      drainFrame.current = null;
      feed.current?.clear();
      feed.current = null;
      h.unmount();
      previousFeatures.current = new Map();
      hoverShown.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts, client]);

  // ---- lens → host, mode → host ----
  useEffect(() => {
    if (lens && host) host.setLens(lens);
  }, [lens, host]);
  useEffect(() => {
    if (host && mounted === 'ready') {
      host.setMode(ui.mode);
      dispatch({ type: 'ui/activeMode', mode: host.activeMode() });
    }
  }, [ui.mode, host, mounted, dispatch]);

  // ---- subscription (types from lens, bounds from view, pinned selection) ----
  // Keyed on the subscription the view needs, not on the view: a key built from the camera's
  // bounds changed as a globe-wide view rotated, and every change re-sent the whole world.
  const wantedBounds = nextSubscriptionBounds(subscribedBounds.current, world.view);
  subscribedBounds.current = wantedBounds;
  const pinned = pinnedSelection({
    selectedId: world.selectedId,
    selectedKind: world.selectedKind,
    selectedType: world.selectedObject?.type,
    bounded: wantedBounds !== undefined,
    lensTypes: lens?.objectTypes,
  });
  const subKey = `${lenses.activeId}|${wantedBounds ? boundsText(wantedBounds) : 'world'}|${pinned ?? ''}|${session.status}`;
  useEffect(() => {
    if (session.status !== 'ready' || !lens) return;
    let cancelled = false;
    const subscription: WorldSubscription = { objectTypes: lens.objectTypes };
    if (wantedBounds) subscription.bounds = wantedBounds;
    if (pinned) subscription.pinnedIds = [pinned];
    client
      .request('world.subscribe', subscription)
      .then((r) => {
        markDelta(r.snapshot.length);
        perf.current.subscribes++;
        perf.current.snapshotMax = Math.max(perf.current.snapshotMax, r.snapshot.length);
        if (!cancelled) dispatch({ type: 'world/snapshot', objects: r.snapshot, count: r.count, subscription });
      })
      .catch((err: unknown) => {
        if (!cancelled) actions.notify('World subscription failed', describeError(err), 'MINOR');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subKey, client]);

  // ---- map providers → renderer ----
  // `DesktopRendererHost` has had `setBasemap` and `setTerrain` all along, with tests, and
  // nothing ever called them: they were missing from `RendererHostLike`, which is the only
  // surface the shell codes against. So choosing Esri World Imagery in Settings moved the
  // credit line — the shell computes that from the setting itself, a few lines below — and
  // left the imagery untouched, which looks exactly like a provider that keeps failing.
  // It never failed. It was never asked.
  const activeMode = ui.activeMode;
  const basemapEntry = basemapForMode(session.mapProviders, session.settings?.basemapId, activeMode);
  const terrainEntry = terrainFor(session.mapProviders, session.settings?.terrainId);
  useEffect(() => {
    if (!host || mounted !== 'ready' || !basemapEntry || !host.setBasemap) return;
    void Promise.resolve(host.setBasemap(basemapEntry.descriptor as BasemapDescriptor)).catch((err: unknown) =>
      actions.notify('Basemap', describeError(err), 'MINOR'),
    );
    // `activeMode` is a dependency because the two renderers hold their basemaps
    // separately: the one that arrives after a switch has to be told as well.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, mounted, basemapEntry?.id, activeMode]);
  useEffect(() => {
    if (!host || mounted !== 'ready' || !terrainEntry || !host.setTerrain) return;
    void Promise.resolve(host.setTerrain(terrainEntry.descriptor as TerrainDescriptor)).catch((err: unknown) =>
      actions.notify('Terrain', describeError(err), 'MINOR'),
    );
    // Re-sent on a mode switch too: the 3D renderer is built lazily, and the host replays
    // terrain into it on arrival, but only if it was ever told.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, mounted, terrainEntry?.id, activeMode]);

  // ---- reference layer: faint borders and country/state names (Natural Earth, bundled) ----
  // Loaded the first time either switch is on, then handed to the host, which keeps it for
  // a renderer built later. Switching both off removes the layer without unloading the data.
  const referenceSettings = session.settings?.reference;
  const referenceWanted = Boolean(referenceSettings && (referenceSettings.borders || referenceSettings.labels));
  const [referenceData, setReferenceData] = useState<ReferenceData | null>(null);
  useEffect(() => {
    if (!referenceWanted || referenceData) return;
    let cancelled = false;
    loadReferenceData()
      .then((data) => {
        if (!cancelled) setReferenceData(data);
      })
      .catch((err: unknown) => actions.notify('Borders and names', describeError(err), 'MINOR'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceWanted, referenceData]);
  useEffect(() => {
    if (!host || mounted !== 'ready' || !host.setReference) return;
    host.setReference(referenceData, {
      borders: referenceSettings?.borders ?? false,
      labels: referenceSettings?.labels ?? false,
    });
  }, [host, mounted, referenceData, referenceSettings?.borders, referenceSettings?.labels]);

  // ---- tile prefetch: the next zoom levels of where the camera came to rest ----
  // Only for a basemap the disk tile cache serves (map-providers.ts `tileCache`); main does
  // the fetching, bounded, behind anything the page itself is loading (main/tile-cache.ts).
  const prefetchSource = basemapEntry?.tileCache ? basemapEntry.id : undefined;
  const view = world.view;
  useEffect(() => {
    if (!prefetchSource || !view.bounds || session.status !== 'ready') return;
    const bounds = view.bounds;
    const zoom = view.zoom;
    const timer = setTimeout(() => {
      client.request('tiles.prefetch', { sourceId: prefetchSource, bounds, zoom }).catch(() => undefined);
    }, PREFETCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [client, prefetchSource, view, session.status]);

  // ---- presentation loop (coalesced to one animation frame; the frame always reads the latest inputs) ----
  // The Overview's layer switches (overview-layers.ts) only narrow what is presented; the
  // subscription above keeps every type flowing, so a switch shows or hides at once.
  const hiddenLayers = session.settings?.hiddenLayers;
  const filter = useMemo(() => (lens ? lensFilter(lens, hiddenLayers ?? []) : undefined), [lens, hiddenLayers]);
  const visibleTypes = filter?.objectTypes;
  const latest = useRef<{
    world: typeof world;
    visibleTypes: ReadonlySet<string> | undefined;
    eventTypes: ReadonlySet<string> | undefined;
  } | null>(null);
  latest.current = { world, visibleTypes, eventTypes: filter?.eventTypes };
  // Presentation depends on the LOD band, never on the exact camera. With view culling off
  // (renderers cull on the GPU) and no clustering, nothing it produces changes while the
  // camera moves within a band — so re-running it on every camera update was pure cost,
  // and it was the cost: a full pass over every object on the main thread, per frame.
  const band = lodBand(world.view.zoom);
  const bandRef = useRef(band);
  bandRef.current = band;
  // Hands queued changes to the renderer a frame-budgeted slice per frame (feature-feed.ts).
  // Only refs are touched, so one function serves every render.
  const scheduleDrain = useCallback(() => {
    if (drainFrame.current !== null) return;
    drainFrame.current = nextFrame(function drain() {
      drainFrame.current = null;
      const f = feed.current;
      if (!f) return;
      const r = f.drain();
      const pw = perf.current;
      pw.applyFrames++;
      pw.applyMaxMs = Math.max(pw.applyMaxMs, r.ms);
      pw.backlogMax = Math.max(pw.backlogMax, r.backlog + r.applied);
      if (r.backlog > 0) drainFrame.current = nextFrame(drain);
    });
  }, []);
  useEffect(() => {
    if (!host || mounted !== 'ready' || !host.setFeatures) return;
    if (frame.current !== null) return;
    frame.current = nextFrame(() => {
      frame.current = null;
      const input = latest.current;
      if (!input) return;
      const { world: w, visibleTypes: vt, eventTypes: et } = input;
      const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const result = presentObjects({
        objects: w.objects.values(),
        events: et ? [...w.events.values()].filter((e) => et.has(e.type)) : [],
        view: w.view,
        ...(vt ? { visibleTypes: vt } : {}),
        selectedId: w.selectedId,
        hoveredId: w.hoveredId,
        selectedTrack: w.track,
        maxFeatures: budget.maxFeatures,
        detail: budget.detail,
        cullToView: false,
      });
      const update = diffFeatures(previousFeatures.current, result.upsert);
      // The diff has already indexed this pass; building a second map of every feature was
      // a whole extra walk per pass for nothing.
      previousFeatures.current = update.index;
      hoverShown.current = w.hoveredId;
      const took = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
      const pw = perf.current;
      pw.passes++;
      pw.presentMs += took;
      pw.presentMaxMs = Math.max(pw.presentMaxMs, took);
      pw.changed += update.upsert.length + update.remove.length;
      if (!update.upsert.length && !update.remove.length) return;
      // Handed over from the *next* frame on, in budgeted slices: this frame has already
      // paid for presentation, and a refresh that moves every satellite at once used to put
      // presentation and the whole renderer update into the same frame.
      feed.current ??= new FeatureFeed((u) => host.setFeatures!(u));
      feed.current.enqueue(update);
      scheduleDrain();
    });
    // `world` is deliberately not a dependency: it changes with every camera update. The
    // parts that change what is drawn are listed instead, and the frame reads the rest.
    // The hover target is read too, but it is not a reason for a pass: see below.
  }, [
    host,
    mounted,
    world.objects,
    world.events,
    world.selectedId,
    world.track,
    band,
    visibleTypes,
    budget,
    scheduleDrain,
  ]);

  // ---- hover: restyle the (at most two) features it touches, not the frame ----
  // The cursor crosses a dot every few frames on a busy overview, and each crossing used to
  // cost a full presentation pass. `restyleHover` gives the same two features a full pass
  // would; a full pass that is already on its way reads the new target anyway, and diffs
  // against the restyled frame, so nothing is sent twice.
  useEffect(() => {
    if (!host || mounted !== 'ready' || !host.setFeatures) return;
    const to = world.hoveredId;
    const patch = restyleHover(previousFeatures.current, hoverShown.current, to);
    hoverShown.current = to;
    if (!patch.length) return;
    for (const f of patch) previousFeatures.current.set(f.id, f);
    perf.current.changed += patch.length;
    feed.current ??= new FeatureFeed((u) => host.setFeatures!(u));
    feed.current.enqueue({ upsert: patch, remove: [] });
    scheduleDrain();
  }, [host, mounted, world.hoveredId, scheduleDrain]);

  // ---- on-screen attribution: sources of what is visible + basemap ----
  const attribution = useMemo(() => {
    const seen = new Set<string>();
    for (const o of world.objects.values()) {
      const text =
        o.provenance.attribution ??
        sources.entries.find((s) => s.providerId === o.provenance.providerId)?.meta.attribution;
      if (text) seen.add(text);
      if (seen.size >= 3) break;
    }
    // The basemap actually drawn, not the one configured: 2D on a fresh install is configured
    // for Natural Earth II, which only the globe can show, and credited it over an empty map.
    const credit = basemapEntry?.attribution;
    return [...(credit ? [credit] : []), ...seen];
  }, [world.objects, sources.entries, basemapEntry?.attribution]);

  return (
    <div className="wv-map" role="region" aria-label="Map">
      <div ref={containerRef} className="wv-map__surface" />
      {mounted === 'missing' ? (
        <div className="wv-map__state">
          <EmptyState
            icon="globe"
            title="No map renderer is available"
            description="The shell was started without a renderer host. In Electron the Cesium/MapLibre host is injected; the browser demo uses the canvas host."
          />
        </div>
      ) : null}
      {mounted === 'error' ? (
        <div className="wv-map__state">
          <EmptyState
            icon="error"
            title="The renderer could not start"
            description={errorText ?? 'Unknown renderer error'}
          />
        </div>
      ) : null}
      {mounted === 'ready' ? <BasemapNotice /> : null}
      <div className="wv-map__controls" role="group" aria-label="Map controls">
        <div className="wv-map__modes" role="radiogroup" aria-label="Render mode">
          <button
            type="button"
            role="radio"
            aria-checked={ui.activeMode === '2D'}
            className={`wv-map__mode${ui.activeMode === '2D' ? ' wv-map__mode--active' : ''}`}
            onClick={() => void actions.setMode('2D')}
            title="2D map (2)"
          >
            <Icon name="map2d" size={14} /> 2D
          </button>
          {supports3D ? (
            <button
              type="button"
              role="radio"
              aria-checked={ui.activeMode === '3D'}
              className={`wv-map__mode${ui.activeMode === '3D' ? ' wv-map__mode--active' : ''}`}
              onClick={() => void actions.setMode('3D')}
              title="3D globe (3)"
            >
              <Icon name="map3d" size={14} /> 3D
            </button>
          ) : null}
        </div>
        {world.selectedId ? (
          <Button size="sm" variant="secondary" icon="close" onClick={() => actions.clearSelection()}>
            Clear selection
          </Button>
        ) : null}
      </div>
      {attribution.length ? (
        <div className="wv-map__attribution" aria-label="Attribution">
          {attribution.join(' · ')}
        </div>
      ) : null}
    </div>
  );
}
