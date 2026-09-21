import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { IconButton } from '../button/button.js';
import { Icon } from '../icon/icon.js';
import { StatusBadge } from '../badge/status-badge.js';
import { TIMELINE_SPEEDS, canScrub, formatCursor, fractionToMs, mergedAvailability, msToFraction, type TimelineAction, type TimelineControlState, type TimelineSpeed } from './timeline-reducer.js';
import './timeline.css';

export interface TimelineProps {
  state: TimelineControlState;
  dispatch: (action: TimelineAction) => void;
  /** Object type → display name for availability rows. */
  typeLabels?: Readonly<Record<string, string>> | undefined;
  className?: string | undefined;
}

const STEP_MS = 60_000;

/**
 * Bottom timeline bar: PLAY/PAUSE, speed, LIVE, scrub track with availability marks.
 * The handle is a slider (arrow keys step 1 min, PageUp/Down 1 h, Home = earliest available, End = live).
 */
export function Timeline({ state, dispatch, typeLabels, className }: TimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const playing = state.mode === 'LIVE' || state.mode === 'REPLAY';
  const scrubbable = canScrub(state);
  const windows = mergedAvailability(state.availability);
  const cursorPct = msToFraction(state.cursorMs, state.range) * 100;

  const msFromPointer = (e: PointerEvent<HTMLDivElement>): number => {
    const el = trackRef.current;
    if (!el) return state.cursorMs;
    const rect = el.getBoundingClientRect();
    const fraction = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 1;
    return fractionToMs(fraction, state.range);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!scrubbable || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dispatch({ type: 'scrubStart' });
    dispatch({ type: 'scrubTo', ms: msFromPointer(e) });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { if (state.scrubbing) dispatch({ type: 'scrubTo', ms: msFromPointer(e) }); };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!state.scrubbing) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dispatch({ type: 'scrubEnd' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!scrubbable) return;
    const first = windows[0]?.startMs;
    switch (e.key) {
      case 'ArrowLeft': dispatch({ type: 'step', deltaMs: -STEP_MS }); break;
      case 'ArrowRight': dispatch({ type: 'step', deltaMs: STEP_MS }); break;
      case 'PageDown': dispatch({ type: 'step', deltaMs: -60 * STEP_MS }); break;
      case 'PageUp': dispatch({ type: 'step', deltaMs: 60 * STEP_MS }); break;
      case 'Home': if (first !== undefined) dispatch({ type: 'scrubTo', ms: first }); break;
      case 'End': dispatch({ type: 'jumpToLive' }); break;
      case ' ': dispatch({ type: 'togglePlay' }); break;
      default: return;
    }
    e.preventDefault();
  };

  return (
    <div className={`wv-timeline${className ? ` ${className}` : ''}`} role="group" aria-label="Timeline">
      <div className="wv-timeline__transport">
        <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} variant="secondary" onClick={() => dispatch({ type: 'togglePlay' })} />
        <div className="wv-timeline__speeds" role="radiogroup" aria-label="Playback speed">
          {TIMELINE_SPEEDS.map((s: TimelineSpeed) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={state.speed === s}
              className={`wv-timeline__speed wv-num${state.speed === s ? ' wv-timeline__speed--active' : ''}`}
              onClick={() => dispatch({ type: 'setSpeed', speed: s })}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <div className="wv-timeline__track-wrap">
        <div
          ref={trackRef}
          className={`wv-timeline__track${scrubbable ? '' : ' wv-timeline__track--disabled'}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="wv-timeline__marks" aria-hidden="true">
            {windows.map((w, i) => {
              const left = msToFraction(w.startMs, state.range) * 100;
              const right = msToFraction(Math.min(w.endMs, state.nowMs), state.range) * 100;
              return <span key={i} className="wv-timeline__mark" style={{ left: `${left}%`, width: `${Math.max(0.5, right - left)}%` }} />;
            })}
          </div>
          <div
            role="slider"
            tabIndex={scrubbable ? 0 : -1}
            aria-label="Time cursor"
            aria-valuemin={state.range.startMs}
            aria-valuemax={state.nowMs}
            aria-valuenow={state.cursorMs}
            aria-valuetext={formatCursor(state.cursorMs, state.nowMs)}
            aria-disabled={!scrubbable}
            className={`wv-timeline__handle${state.scrubbing ? ' wv-timeline__handle--active' : ''}`}
            style={{ left: `${cursorPct}%` }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="wv-timeline__meta">
          <span className="wv-timeline__cursor wv-mono">{formatCursor(state.cursorMs, state.nowMs)}</span>
          {scrubbable ? (
            <span className="wv-timeline__availability">
              {state.availability.filter((r) => r.ranges.length > 0).map((r) => (
                <span key={r.objectType} className="wv-timeline__avail-type">{typeLabels?.[r.objectType] ?? r.objectType}</span>
              ))}
            </span>
          ) : (
            <span className="wv-timeline__availability wv-timeline__availability--none"><Icon name="info" size={12} /> No history available yet</span>
          )}
        </div>
      </div>

      <div className="wv-timeline__live">
        {state.mode === 'LIVE' ? (
          <StatusBadge kind="freshness" value="LIVE" />
        ) : (
          <button type="button" className="wv-timeline__live-btn" onClick={() => dispatch({ type: 'jumpToLive' })}>
            <Icon name="live" size={14} /> LIVE
          </button>
        )}
        <span className="wv-timeline__mode wv-caps" aria-live="polite">{state.mode}</span>
      </div>
    </div>
  );
}
