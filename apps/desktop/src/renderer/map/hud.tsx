import { useEffect, useState } from 'react';
import { geodesicInverse, type GeoPosition } from '@worldview/world-model';
import type { ViewState, VisualStyleId } from '@worldview/render-core';
import type { RendererHostLike } from '../renderer-host-like.js';
import { useNow } from '../hooks/use-now.js';
import { VISUAL_STYLE_NAMES } from '../store/display.js';
import {
  formatAltitude,
  formatDecimal,
  formatDms,
  formatGridReference,
  formatHeading,
  formatPitch,
  formatUtc,
  formatZoom,
} from './hud-format.js';
import { formatDistance } from './measure.js';

/**
 * The view as the renderer reports it, at most once an animation frame.
 *
 * The HUD listens to the host itself rather than reading the store's view: that one is
 * throttled to four updates a second on purpose (map-host.tsx), which is right for the shell
 * and visibly laggy for a readout that should move with the camera. Only this small
 * component re-renders at frame rate, and only while the camera moves.
 */
function useHostView(host: RendererHostLike | null): ViewState | null {
  const [view, setView] = useState<ViewState | null>(() => host?.getView() ?? null);
  useEffect(() => {
    if (!host) return;
    setView(host.getView());
    let latest: ViewState | null = null;
    let frame: number | null = null;
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (h: number) => clearTimeout(h);
    const offView = host.on('viewChanged', (v) => {
      latest = v;
      frame ??= raf(() => {
        frame = null;
        setView(latest);
      });
    });
    const offMode = host.on('modeChanged', () => setView(host.getView()));
    return () => {
      offView();
      offMode();
      if (frame !== null) caf(frame);
    };
  }, [host]);
  return view;
}

/**
 * The ground under the pointer, as the renderer reports it (at most once a frame), or `null`
 * while the pointer is off the map. A new renderer (a switch between 2D and 3D) starts with
 * none until the pointer moves over it.
 */
function useHostPointer(host: RendererHostLike | null): GeoPosition | null {
  const [at, setAt] = useState<GeoPosition | null>(null);
  useEffect(() => {
    if (!host) return;
    const offPointer = host.on('pointer', (p) => setAt(p ? p.position : null));
    const offMode = host.on('modeChanged', () => setAt(null));
    return () => {
      offPointer();
      offMode();
      setAt(null);
    };
  }, [host]);
  return at;
}

/**
 * The range row's text: distance and initial bearing from the selection to the ground under
 * the pointer (`412 km 047°`) on the WGS84 ellipsoid, as the measure tool gives them, or
 * undefined unless both are known.
 */
export function rangeReadout(from: GeoPosition | undefined, to: GeoPosition | null): string | undefined {
  if (!from || !to) return undefined;
  const g = geodesicInverse(from, to);
  return `${formatDistance(g.distanceM)} ${formatHeading(g.initialBearingDeg)}`;
}

/**
 * The cursor row's text: the ground under the pointer — in the HUD's grid reference when one is
 * chosen, otherwise degrees — or a dash while it is off the map.
 */
export function cursorReadout(at: GeoPosition | null, grid?: HudGrid): string {
  if (!at) return '—';
  return grid ? formatGridReference(at.latitude, at.longitude, grid) : formatDecimal(at.latitude, at.longitude);
}

/** The grid reference the HUD adds (Settings → Rendering → Grid reference in the HUD). */
export type HudGrid = 'mgrs' | 'utm';

export interface HudProps {
  host: RendererHostLike | null;
  mode: '2D' | '3D';
  visualStyle: VisualStyleId;
  orbit: boolean;
  following: boolean;
  /** Where the selection is, if anything is selected: the RNG row measures from it to the pointer. */
  selection?: GeoPosition;
  /** A grid reference row for the view centre, and the pointer given in it (absent: degrees only). */
  grid?: HudGrid;
  /** The timeline's mode and the moment the map shows (paused, replaying or in history). */
  timeMode?: 'LIVE' | 'PAUSED' | 'REPLAY' | 'HISTORICAL';
  shownAtMs?: number;
}

/**
 * The HUD's clock: the time of what the map shows. Live, that is now; paused or replaying it
 * is the timeline's moment, tagged, so a picture from an hour ago does not carry the current
 * time (QA 2026-10-04: paused at 06:14:14, the HUD read 06:14:27 and counting).
 */
export function hudClock(
  nowMs: number,
  timeMode: HudProps['timeMode'],
  shownAtMs: number | undefined,
): { atMs: number; tag?: string } {
  if (!timeMode || timeMode === 'LIVE' || shownAtMs === undefined || !Number.isFinite(shownAtMs))
    return { atMs: nowMs };
  return { atMs: shownAtMs, tag: timeMode };
}

/**
 * Heads-up display over the map (Settings → Rendering → HUD, or H): the ground at the middle of
 * the view in decimal degrees and degrees-minutes-seconds — and as an MGRS or UTM reference
 * when one is chosen — the ground under the pointer (CUR, in that reference if chosen), the
 * range and bearing to it from the selection (RNG), the camera's altitude (3D) or
 * zoom (2D), heading and pitch, the UTC clock, the visual style, and a small reticle on the
 * point the coordinates are for.
 *
 * It is drawn by the page, not by the renderer, so no visual style's filter touches it: the
 * night-vision, thermal and CRT looks tint it to match instead (shell.css). It takes no
 * pointer events, has fixed-width fields so nothing shifts as the numbers change, and is
 * hidden from assistive technology: a readout that changes on every frame of camera motion
 * would be read out without end.
 */
export function Hud({ host, mode, visualStyle, orbit, following, selection, grid, timeMode, shownAtMs }: HudProps) {
  const view = useHostView(host);
  const cursor = useHostPointer(host);
  const range = rangeReadout(selection, cursor);
  const now = useNow(1000);
  const clock = hudClock(now, timeMode, shownAtMs);
  const at = view?.focus ?? view?.center;
  return (
    <div className="wv-hud" data-style={visualStyle} aria-hidden="true">
      <div className="wv-hud__reticle" />
      <div className="wv-hud__top">
        <span>{formatUtc(clock.atMs)}</span>
        {clock.tag ? <span className="wv-hud__tag">{clock.tag}</span> : null}
        <span className="wv-hud__sep">·</span>
        <span>{mode}</span>
        <span className="wv-hud__sep">·</span>
        <span>{VISUAL_STYLE_NAMES[visualStyle].toUpperCase()}</span>
        {orbit ? <span className="wv-hud__tag">ORBIT</span> : null}
        {following ? <span className="wv-hud__tag">FOLLOW</span> : null}
      </div>
      <dl className="wv-hud__readout">
        <dt>POS</dt>
        <dd>{at ? formatDecimal(at.latitude, at.longitude) : '—'}</dd>
        <dt>DMS</dt>
        <dd>{at ? formatDms(at.latitude, at.longitude) : '—'}</dd>
        {grid ? (
          <>
            <dt>{grid.toUpperCase()}</dt>
            <dd>{at ? formatGridReference(at.latitude, at.longitude, grid) : '—'}</dd>
          </>
        ) : null}
        <dt>CUR</dt>
        <dd>{cursorReadout(cursor, grid)}</dd>
        {range ? (
          <>
            <dt>RNG</dt>
            <dd>{range}</dd>
          </>
        ) : null}
        {mode === '3D' ? (
          <>
            <dt>ALT</dt>
            <dd>{view ? formatAltitude(view.altitudeM) : '—'}</dd>
          </>
        ) : (
          <>
            <dt>ZOOM</dt>
            <dd>{view ? formatZoom(view.zoom) : '—'}</dd>
          </>
        )}
        <dt>HDG</dt>
        <dd>
          {view ? formatHeading(view.headingDegrees) : '—'}
          <span className="wv-hud__label"> PITCH </span>
          {view ? formatPitch(view.pitchDegrees) : '—'}
        </dd>
      </dl>
    </div>
  );
}
