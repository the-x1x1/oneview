import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '@worldview/ui';
import {
  clampSplit,
  reconcileSplit,
  splitCandidates,
  stepSplit,
  type ImagerySplit,
  type SplitCandidate,
} from '@worldview/render-core';
import type { RasterOverlay } from '@worldview/world-model';

/**
 * The imagery comparison's divider (render-core imagery-split.ts): a vertical line across the
 * map with a handle to drag, and a chooser at the top for what is drawn on each side — an
 * overlay source, or "Map only" for the map as it is. Adapted from God's Eye View's split
 * divider (src/ui/imagerySplit.js, MIT): the handle is a slider for assistive technology and
 * the keyboard (arrows by 1 %, with Shift by 5 %, Home and End), and a drag holds the pointer
 * so it can leave the handle without letting go.
 *
 * A drag moves the divider on the renderer directly (`preview`), once a pointer event, and the
 * position reaches the store only when the drag ends (`commit`): the store update re-renders the
 * map host, which is fine once and wasteful sixty times a second. On the globe each move is
 * one frame (render-cesium raster-overlays.ts sets `scene.splitPosition` and asks for it); in
 * 2D the divider cross-fades the two sources instead, which the note under the chooser says.
 */
export interface ImageryCompareProps {
  split: ImagerySplit;
  /** Overlays drawn now (map-providers.ts `overlaysToDraw`). */
  overlays: readonly RasterOverlay[];
  mode: '2D' | '3D';
  /** Move the divider on the renderer without touching the store. */
  preview: (split: ImagerySplit) => void;
  /** Keep a change (sides chosen, a drag ended, a key pressed). */
  commit: (split: ImagerySplit | null) => void;
}

/** The divider position from a pointer's x over the map's box. Pure, for the tests. */
export function positionFromPointer(clientX: number, box: { left: number; width: number }): number | undefined {
  if (!(box.width > 0) || !Number.isFinite(clientX)) return undefined;
  return clampSplit((clientX - box.left) / box.width);
}

/** What the handle announces: how much of the map each side has. */
export function splitValueText(split: ImagerySplit, candidates: readonly SplitCandidate[]): string {
  const name = (id: string | null) => (id ? (candidates.find((c) => c.providerId === id)?.name ?? id) : 'Map only');
  const left = Math.round(clampSplit(split.position) * 100);
  return `${name(split.left)} ${left} percent, ${name(split.right)} ${100 - left} percent`;
}

const MAP_ONLY = '';

export function ImageryCompare({ split, overlays, mode, preview, commit }: ImageryCompareProps) {
  const candidates = useMemo(() => splitCandidates(overlays), [overlays]);
  const [position, setPosition] = useState(split.position);
  const dragging = useRef<number | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // A position the store changed (a new comparison, a side chosen) wins over the local one.
  useEffect(() => setPosition(split.position), [split.position]);

  // A source that stops being drawn leaves its side: that side becomes the map as it is.
  useEffect(() => {
    const next = reconcileSplit(split, candidates);
    if (next !== split) commit(next);
  }, [split, candidates, commit]);

  const move = (next: number, keep: boolean) => {
    setPosition(next);
    const updated = { ...split, position: next };
    if (keep) commit(updated);
    else preview(updated);
  };

  const fromPointer = (e: ReactPointerEvent<HTMLElement>) => {
    const box = root.current?.getBoundingClientRect();
    return box ? positionFromPointer(e.clientX, box) : undefined;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = e.pointerId;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragging.current !== e.pointerId) return;
    const next = fromPointer(e);
    if (next !== undefined) move(next, false);
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragging.current !== e.pointerId) return;
    dragging.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const next = fromPointer(e);
    move(next ?? position, true);
  };

  const side = (which: 'left' | 'right') => (
    <label className="wv-compare__side">
      <span className="wv-compare__label">{which === 'left' ? 'Left' : 'Right'}</span>
      <select
        className="wv-select"
        value={split[which] ?? MAP_ONLY}
        onChange={(e) => commit({ ...split, position, [which]: e.target.value === MAP_ONLY ? null : e.target.value })}
      >
        <option value={MAP_ONLY}>Map only</option>
        {candidates.map((c) => (
          <option key={c.providerId} value={c.providerId}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );

  const pct = `${position * 100}%`;
  return (
    <div className="wv-compare" ref={root}>
      <div className="wv-compare__bar" role="group" aria-label="Compare imagery">
        {side('left')}
        {side('right')}
        <button type="button" className="wv-compare__close" onClick={() => commit(null)} title="Stop comparing">
          <Icon name="close" size={14} />
        </button>
        {mode === '2D' ? (
          <span className="wv-compare__note">
            In 2D the divider fades between the two; switch to 3D for a side-by-side split.
          </span>
        ) : null}
      </div>
      <div className="wv-compare__line" style={{ left: pct }}>
        <button
          type="button"
          className="wv-compare__handle"
          role="slider"
          aria-label="Imagery divider"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(position * 100)}
          aria-valuetext={splitValueText({ ...split, position }, candidates)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={(e) => {
            const next = stepSplit(position, e.key, e.shiftKey);
            if (next === undefined) return;
            e.preventDefault();
            move(next, true);
          }}
        >
          ↔
        </button>
      </div>
    </div>
  );
}
