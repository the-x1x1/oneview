import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoBounds } from '@worldview/world-model';
import type { WorldSubscription } from '@worldview/ipc-contract';
import { diffFeatures, lensById, presentObjects, type RenderFeature, type ViewState } from '@worldview/render-core';
import { Button, EmptyState, Icon } from '@worldview/ui';
import { useActions, useAppState, useClient, useDispatch, useHosts } from '../store/store.js';
import { selectBasemap } from '../map-providers.js';
import { describeError } from '../store/sync.js';

const VIEWPORT_THROTTLE_MS = 500;

function boundsKey(b: GeoBounds | undefined, zoom: number): string {
  if (!b) return `none@${zoom.toFixed(1)}`;
  // Subscription bounds are padded and quantised so small pans do not resubscribe.
  const pad = Math.max(0.5, (b.north - b.south) * 0.25);
  const q = (v: number) => Math.round(v / pad) * pad;
  return `${q(b.west - pad)},${q(b.south - pad)},${q(b.east + pad)},${q(b.north + pad)}`;
}

export function paddedBounds(b: GeoBounds): GeoBounds {
  const pad = Math.max(0.5, (b.north - b.south) * 0.25);
  return {
    west: Math.max(-180, b.west - pad),
    east: Math.min(180, b.east + pad),
    south: Math.max(-90, b.south - pad),
    north: Math.min(90, b.north + pad),
  };
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
  const frame = useRef<number | null>(null);
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastViewportAt = useRef(0);
  const pendingView = useRef<ViewState | null>(null);

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
    const sendViewport = (view: ViewState) => {
      dispatch({ type: 'world/view', view });
      const now = Date.now();
      const flush = () => {
        const v = pendingView.current;
        pendingView.current = null;
        if (!v || disposed || !v.bounds) return;
        lastViewportAt.current = Date.now();
        client
          .request('world.viewport', { bounds: v.bounds, zoom: v.zoom })
          .catch((err: unknown) => console.warn('[worldview] world.viewport failed:', describeError(err)));
      };
      pendingView.current = view;
      if (now - lastViewportAt.current >= VIEWPORT_THROTTLE_MS) {
        flush();
        return;
      }
      if (viewportTimer.current === null)
        viewportTimer.current = setTimeout(
          () => {
            viewportTimer.current = null;
            flush();
          },
          VIEWPORT_THROTTLE_MS - (now - lastViewportAt.current),
        );
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
    offs.push(h.on('modeChanged', ({ mode }) => dispatch({ type: 'ui/activeMode', mode })));
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
          sendViewport(h.getView());
        }
      }),
    );
    Promise.resolve(h.mount(el))
      .then(() => {
        if (!disposed) {
          setMounted('ready');
          dispatch({ type: 'ui/activeMode', mode: h.activeMode() });
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
      if (viewportTimer.current !== null) clearTimeout(viewportTimer.current);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      h.unmount();
      previousFeatures.current = new Map();
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
  const subKey = `${lenses.activeId}|${boundsKey(world.view.bounds, world.view.zoom)}|${world.selectedKind === 'object' ? (world.selectedId ?? '') : ''}|${session.status}`;
  useEffect(() => {
    if (session.status !== 'ready' || !lens) return;
    let cancelled = false;
    const subscription: WorldSubscription = { objectTypes: lens.objectTypes };
    if (world.view.bounds && world.view.zoom >= 3) subscription.bounds = paddedBounds(world.view.bounds);
    if (world.selectedKind === 'object' && world.selectedId) subscription.pinnedIds = [world.selectedId];
    client
      .request('world.subscribe', subscription)
      .then((r) => {
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

  // ---- presentation loop (coalesced to one animation frame; the frame always reads the latest inputs) ----
  const visibleTypes = useMemo(() => (lens ? new Set(lens.objectTypes) : undefined), [lens]);
  const latest = useRef<{ world: typeof world; visibleTypes: Set<string> | undefined; lens: typeof lens } | null>(null);
  latest.current = { world, visibleTypes, lens };
  useEffect(() => {
    if (!host || mounted !== 'ready' || !host.setFeatures) return;
    if (frame.current !== null) return;
    const schedule =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: (t: number) => void) => setTimeout(() => cb(0), 16) as unknown as number;
    frame.current = schedule(() => {
      frame.current = null;
      const input = latest.current;
      if (!input) return;
      const { world: w, visibleTypes: vt, lens: l } = input;
      const result = presentObjects({
        objects: w.objects.values(),
        events: l ? [...w.events.values()].filter((e) => l.eventTypes.includes(e.type)) : [],
        view: w.view,
        ...(vt ? { visibleTypes: vt } : {}),
        selectedId: w.selectedId,
        hoveredId: w.hoveredId,
        selectedTrack: w.track,
        maxFeatures: 20_000,
      });
      const update = diffFeatures(previousFeatures.current, result.upsert);
      const next = new Map<string, RenderFeature>();
      for (const f of result.upsert) next.set(f.id, f);
      previousFeatures.current = next;
      if (update.upsert.length || update.remove.length) host.setFeatures!(update);
    });
  }, [host, mounted, world, visibleTypes, lens]);

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
    const basemap = selectBasemap(session.mapProviders, session.settings?.basemapId);
    return [...(basemap?.attribution ? [basemap.attribution] : []), ...seen];
  }, [world.objects, sources.entries, session.mapProviders, session.settings?.basemapId]);

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
