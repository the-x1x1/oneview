import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GeoPosition, WorldObject } from '@worldview/world-model';
import type { CameraStreamDescriptor } from '@worldview/ipc-contract';
import type { WorldClient } from '@worldview/ipc-contract';
import { useClient } from '../store/store.js';
import type { RendererHostLike } from '../renderer-host-like.js';
import { displayName } from '../context/props.js';
import { cameraIdOf, cameraVideoKind, canPlayHlsNatively, snapshotPollMs } from '../context/sections.js';
import { readMjpeg } from '../context/mjpeg.js';
import { inBounds } from '../layer-tree.js';
import {
  PREVIEW_GEOMETRY,
  PREVIEW_MIN_ZOOM,
  choosePreviews,
  layoutTile,
  samePicks,
  type PreviewCandidate,
  type PreviewPick,
} from './camera-preview-layout.js';

/** How long the camera has to be still before the set of tiles is chosen again. */
const SETTLE_MS = 400;
/** Cameras projected when choosing, nearest the middle of the view first; the rest cannot win a tile anyway. */
const MAX_CANDIDATES = 120;
/** Connections in a row that may end without a frame before a live tile falls back to stills. */
const MJPEG_RECONNECTS = 3;

export interface CameraPreviewsProps {
  host: RendererHostLike | null;
  /** The Live previews switch is on, the cameras layer is shown and the renderer is up. */
  enabled: boolean;
  objects: ReadonlyMap<string, WorldObject>;
  /** The line a camera's source requires beside its pictures. */
  attributionFor: (o: WorldObject) => string | undefined;
  onOpen: (objectId: string) => void;
}

/** Video this window can decode for the camera, from its catalogue: MJPEG, or HLS where Chromium plays it. */
export function decodableVideo(o: WorldObject, hlsPlayable: boolean): boolean {
  const kind = cameraVideoKind(o);
  return kind === 'mjpeg' || (kind === 'hls' && hlsPlayable);
}

/**
 * Live pictures pinned above the nearest public cameras once the map is close in (OSIRIS's
 * CCTV previews, brought into WorldView's shell): at most six tiles, at most two of them
 * decoding video and the rest stills refreshed as often as the camera publishes a new one.
 *
 * Every picture comes through the camera gateway — `camera.snapshot` for stills and
 * `camera.stream` for video, whose URL is the loopback relay — exactly as the camera panel
 * gets it: nothing here fetches from a camera's own host. Each tile names its camera and
 * carries its source's attribution in its tooltip; a click opens the camera in the panel.
 *
 * Which cameras get a tile is decided when the camera settles. In between, the tiles follow
 * the map on every frame through the renderer's projection, written straight to the DOM, so
 * a pan does not render React sixty times a second. Off by default: a child switch of
 * Public cameras in the layer panel turns it on.
 */
export const CameraPreviews = memo(function CameraPreviews({
  host,
  enabled,
  objects,
  attributionFor,
  onOpen,
}: CameraPreviewsProps) {
  const client = useClient();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [picks, setPicks] = useState<PreviewPick[]>([]);
  const picksRef = useRef(picks);
  picksRef.current = picks;
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  /** Where each picked camera is, fixed when it was picked (cameras do not move). */
  const positions = useRef(new Map<string, GeoPosition>());
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const viewport = () => {
    const el = rootRef.current;
    return el && el.clientWidth > 0 && el.clientHeight > 0 ? { width: el.clientWidth, height: el.clientHeight } : null;
  };

  // Move the tiles to where their cameras are drawn now. DOM only; no state.
  const place = useCallback(() => {
    const vp = viewport();
    const current = picksRef.current;
    if (!vp || !host?.project || !current.length) return;
    const points = host.project(current.map((p) => positions.current.get(p.id) ?? { latitude: 0, longitude: 0 }));
    current.forEach((p, i) => {
      const el = nodes.current.get(p.id);
      if (!el) return;
      const pt = points[i];
      if (!pt) {
        el.style.visibility = 'hidden';
        return;
      }
      const box = layoutTile(pt, vp);
      el.style.visibility = '';
      // A tile pushed back inside the map is off its camera: no stem pointing at nothing.
      el.dataset.stem = !box.anchored ? 'none' : box.flipped ? 'below' : 'above';
      el.style.transform = `translate3d(${Math.round(box.x)}px, ${Math.round(box.y)}px, 0)`;
    });
  }, [host]);

  // Choose the cameras. Only when the camera has settled, or the cameras on hand changed.
  const recompute = useCallback(() => {
    const vp = viewport();
    const clear = () => setPicks((prev) => (prev.length ? [] : prev));
    if (!enabled || !host?.project || !vp) return clear();
    const view = host.getView();
    if (view.zoom < PREVIEW_MIN_ZOOM) return clear();
    const middle = view.focus ?? view.center;
    const cams: WorldObject[] = [];
    for (const o of objectsRef.current.values())
      if (o.type === 'camera' && o.position && (!view.bounds || inBounds(o.position, view.bounds))) cams.push(o);
    const near = (o: WorldObject) =>
      (o.position!.latitude - middle.latitude) ** 2 + (o.position!.longitude - middle.longitude) ** 2;
    const nearest = cams.sort((a, b) => near(a) - near(b)).slice(0, MAX_CANDIDATES);
    const points = host.project(nearest.map((o) => o.position!));
    const hls = canPlayHlsNatively();
    const candidates: PreviewCandidate[] = [];
    nearest.forEach((o, i) => {
      const point = points[i];
      if (point) candidates.push({ id: o.id, point, video: decodableVideo(o, hls) });
    });
    const next = choosePreviews(candidates, vp);
    for (const p of next) {
      const o = objectsRef.current.get(p.id);
      if (o?.position) positions.current.set(p.id, o.position);
    }
    setPicks((prev) => (samePicks(prev, next) ? prev : next));
  }, [enabled, host]);

  const scheduleRecompute = useCallback(() => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      recompute();
    }, SETTLE_MS);
  }, [recompute]);

  useEffect(() => {
    if (!host) return undefined;
    const offs = [
      // Switched off (the default), a moving camera costs nothing here.
      host.on('viewChanged', () => {
        if (!enabledRef.current) return;
        place();
        scheduleRecompute();
      }),
      host.on('modeChanged', () => {
        if (enabledRef.current) scheduleRecompute();
      }),
    ];
    return () => {
      for (const off of offs) off();
      if (settle.current) clearTimeout(settle.current);
      settle.current = null;
    };
  }, [host, place, scheduleRecompute]);

  // New cameras arrived, or the switch changed: choose again once things are quiet.
  useEffect(() => {
    if (!enabled) {
      setPicks((prev) => (prev.length ? [] : prev));
      return;
    }
    scheduleRecompute();
  }, [enabled, objects, scheduleRecompute]);

  // Tiles that just mounted go straight to their places, before the browser paints them.
  useLayoutEffect(() => {
    place();
  }, [picks, place]);

  if (!picks.length) return <div ref={rootRef} className="wv-previews" aria-hidden="true" />;
  return (
    <div ref={rootRef} className="wv-previews" role="group" aria-label="Live camera previews">
      {picks.map((p) => {
        const object = objects.get(p.id);
        if (!object) return null;
        return (
          <div
            key={p.id}
            ref={(el) => {
              if (el) nodes.current.set(p.id, el);
              else nodes.current.delete(p.id);
            }}
            className="wv-preview"
            data-stem="above"
            style={{ width: PREVIEW_GEOMETRY.width, visibility: 'hidden' }}
          >
            <PreviewTile
              client={client}
              object={object}
              mode={p.mode}
              attribution={attributionFor(object)}
              onOpen={onOpen}
            />
            <span className="wv-preview__stem wv-preview__stem--down" aria-hidden="true" />
            <span className="wv-preview__stem wv-preview__stem--up" aria-hidden="true" />
          </div>
        );
      })}
    </div>
  );
});

/** The tooltip: what the camera is, what the picture is, whose it is. */
export function previewTitle(name: string, mode: 'live' | 'still', attribution: string | undefined): string {
  return [
    name,
    mode === 'live' ? 'Live video, as the agency serves it' : 'Latest still, refreshed as the camera publishes',
    ...(attribution ? [attribution] : []),
    'Click to open the camera',
  ].join('\n');
}

function PreviewTile({
  client,
  object,
  mode,
  attribution,
  onOpen,
}: {
  client: WorldClient;
  object: WorldObject;
  mode: 'live' | 'still';
  attribution: string | undefined;
  onOpen: (objectId: string) => void;
}) {
  const [shown, setShown] = useState<'live' | 'still'>(mode);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setShown(mode);
    setFailed(false);
  }, [mode]);
  const cameraId = cameraIdOf(object);
  const onReady = useCallback(() => setReady(true), []);
  const onFail = useCallback(() => setFailed(true), []);
  const toStill = useCallback(() => setShown('still'), []);
  // A camera that will not load is worse than no tile: a broken box claiming to be a feed.
  if (failed) return null;
  const name = displayName(object);
  return (
    <button
      type="button"
      className="wv-preview__tile"
      title={previewTitle(name, shown, attribution)}
      aria-label={`${name} — open the camera`}
      onClick={() => onOpen(object.id)}
    >
      <span className="wv-preview__picture" style={{ height: PREVIEW_GEOMETRY.imageHeight }}>
        {shown === 'live' ? (
          <LivePicture client={client} cameraId={cameraId} onReady={onReady} onFallback={toStill} />
        ) : (
          <StillPicture
            client={client}
            cameraId={cameraId}
            pollMs={snapshotPollMs(object)}
            onReady={onReady}
            onFail={onFail}
          />
        )}
        {ready ? null : <span className="wv-preview__linking">Linking…</span>}
        <span className={`wv-preview__badge${shown === 'live' ? ' wv-preview__badge--live' : ''}`}>
          {shown === 'live' ? 'LIVE' : 'STILL'}
        </span>
      </span>
      <span className="wv-preview__caption" style={{ height: PREVIEW_GEOMETRY.labelHeight }}>
        {name}
      </span>
    </button>
  );
}

/** A still through `camera.snapshot`, fetched again when the camera publishes its next one. */
function StillPicture({
  client,
  cameraId,
  pollMs,
  onReady,
  onFail,
}: {
  client: WorldClient;
  cameraId: string;
  pollMs: number | undefined;
  onReady: () => void;
  onFail: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!pollMs) return undefined;
    // Staggered, so six tiles do not all ask the gateway on the same tick.
    let interval: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(
      () => {
        setRound((n) => n + 1);
        interval = setInterval(() => setRound((n) => n + 1), pollMs);
      },
      pollMs + Math.random() * 3000,
    );
    return () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    };
  }, [pollMs]);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    client.request('camera.snapshot', { cameraId }).then(
      (snap) => {
        if (cancelled) return;
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return onFail();
        const bytes = new Uint8Array(snap.bytes.byteLength);
        bytes.set(snap.bytes);
        made = URL.createObjectURL(new Blob([bytes], { type: snap.mimeType }));
        setUrl(made);
      },
      // A refresh that fails keeps the picture it has; a first one that fails drops the tile.
      () => {
        if (!cancelled && round === 0) onFail();
      },
    );
    return () => {
      cancelled = true;
      // The previous picture stays on screen until the next one has loaded (see the img's onLoad).
      if (made) setTimeout(() => URL.revokeObjectURL(made!), 2000);
    };
  }, [client, cameraId, round, onFail]);
  return url ? <img className="wv-preview__img" src={url} alt="" draggable={false} onLoad={onReady} /> : null;
}

/**
 * Video through `camera.stream` (the loopback relay): MJPEG read frame by frame, as the
 * camera panel does, or HLS in a muted `<video>`. Anything else, or a stream that will not
 * start or keeps closing, falls back to stills rather than leave a dead tile.
 */
function LivePicture({
  client,
  cameraId,
  onReady,
  onFallback,
}: {
  client: WorldClient;
  cameraId: string;
  onReady: () => void;
  onFallback: () => void;
}) {
  const [stream, setStream] = useState<CameraStreamDescriptor | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    client.request('camera.stream', { cameraId }).then(
      (s) => {
        if (cancelled) return;
        if (s.kind === 'mjpeg' || (s.kind === 'hls' && canPlayHlsNatively())) setStream(s);
        else onFallback();
      },
      () => {
        if (!cancelled) onFallback();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, cameraId, onFallback]);
  useEffect(() => {
    if (stream?.kind !== 'mjpeg') return undefined;
    const abort = new AbortController();
    let current: string | null = null;
    let emptyDrops = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      void readMjpeg(
        stream.url,
        {
          onFrame: (jpeg) => {
            emptyDrops = 0;
            if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
            const next = URL.createObjectURL(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }));
            setFrame(next);
            if (current) URL.revokeObjectURL(current);
            current = next;
          },
          onDrop: (frames) => {
            if (abort.signal.aborted) return;
            if (frames === 0 && ++emptyDrops > MJPEG_RECONNECTS) return onFallback();
            timer = setTimeout(connect, frames > 0 ? 200 : 1500);
          },
        },
        abort.signal,
      );
    };
    connect();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, [stream, onFallback]);
  if (stream?.kind === 'hls')
    return (
      <video
        className="wv-preview__img"
        src={stream.url}
        muted
        autoPlay
        playsInline
        loop
        onLoadedData={onReady}
        onError={onFallback}
      />
    );
  return frame ? <img className="wv-preview__img" src={frame} alt="" draggable={false} onLoad={onReady} /> : null;
}
