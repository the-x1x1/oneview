import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { formatDuration, formatUtcDateTime, formatUtcTime } from '@worldview/ui';
import {
  downsample,
  formatReading,
  gapThreshold,
  limitBands,
  limitState,
  limitText,
  readingAt,
  readingsPath,
  valueRange,
  type ReadingPoint,
  type ReadingWindow,
  type TelemetryOrigin,
  type TelemetrySeries,
} from '@worldview/telemetry';

const W = 1000;
const H = 100;

/** The windows the Readings section offers; the window ends at the timeline's cursor. */
export const READING_WINDOWS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: '1 h', ms: 3_600_000 },
  { label: '6 h', ms: 6 * 3_600_000 },
  { label: '24 h', ms: 24 * 3_600_000 },
  { label: '7 d', ms: 7 * 24 * 3_600_000 },
];

export interface ReadingsViewProps {
  series: ReadonlyArray<TelemetrySeries>;
  /** Points per series key; missing or empty keys are drawn as "no readings". */
  data: ReadonlyMap<string, ReadonlyArray<ReadingPoint>>;
  window: ReadingWindow;
  /** The timeline's cursor (now, when live): the line on every chart and the value read out. */
  cursorMs: number;
  windowMs: number;
  onWindow: (ms: number) => void;
  /** Put the replay cursor at a moment (a click or Enter on a chart). */
  onSeek?: (ms: number) => void;
  origin: TelemetryOrigin;
  /** The history read's slice width: the finest spacing the charts can show. */
  stepMs?: number;
  loading?: boolean;
  /** History reads that failed; their slices are missing. */
  failed?: number;
  error?: string;
}

/**
 * The Readings section's body: one chart per series, stacked on a shared time axis over the
 * window, with the descriptor's units, the limits shaded, and each series' value at the
 * cursor (or where the pointer is). A series with nothing in the window says so; a window
 * with nothing at all says "No readings in this window".
 */
export function ReadingsView(props: ReadingsViewProps) {
  const { series, data, window, cursorMs, windowMs, onWindow, onSeek, origin, stepMs, loading, failed, error } = props;
  const [pointer, setPointer] = useState<number | null>(null);
  const at = pointer ?? Math.min(window.endMs, Math.max(window.startMs, cursorMs));
  const drawn = series.map((s) => ({ s, points: data.get(s.key) ?? [] }));
  const any = drawn.some((d) => d.points.length > 0);
  const span = Math.max(1, window.endMs - window.startMs);
  const notes = [
    stepMs && any ? `At most one reading per ${formatDuration(stepMs)} from history (the last in each)` : undefined,
    failed ? `${failed} history ${failed === 1 ? 'read' : 'reads'} failed, so gaps may hide readings` : undefined,
    origin === 'discovered' ? 'Every number this object reports; its source names none' : undefined,
  ].filter((n): n is string => Boolean(n));

  const fromPointer = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 1;
    return window.startMs + f * span;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = span / 100;
    if (e.key === 'ArrowLeft') setPointer(Math.max(window.startMs, at - step));
    else if (e.key === 'ArrowRight') setPointer(Math.min(window.endMs, at + step));
    else if (e.key === 'Home') setPointer(window.startMs);
    else if (e.key === 'End') setPointer(window.endMs);
    else if ((e.key === 'Enter' || e.key === ' ') && onSeek) onSeek(at);
    else return;
    e.preventDefault();
  };
  const cursorX = ((Math.min(window.endMs, Math.max(window.startMs, cursorMs)) - window.startMs) / span) * W;
  const pointerX = pointer !== null ? ((pointer - window.startMs) / span) * W : undefined;

  return (
    <div className="wv-track wv-readings">
      <div className="wv-track__windows" role="group" aria-label="Readings window">
        {READING_WINDOWS.map((w) => (
          <button
            key={w.ms}
            type="button"
            className={`wv-track__window${w.ms === windowMs ? ' wv-track__window--on' : ''}`}
            aria-pressed={w.ms === windowMs}
            onClick={() => onWindow(w.ms)}
          >
            {w.label}
          </button>
        ))}
      </div>
      <p className="wv-ctx-muted wv-readings__span">
        {formatUtcDateTime(window.startMs)} – {formatUtcDateTime(window.endMs)}
      </p>
      {error ? <p className="wv-ctx-muted">History unavailable: {error}</p> : null}
      {loading ? (
        <p className="wv-ctx-muted">Reading history…</p>
      ) : !any && !error ? (
        <p className="wv-ctx-muted">No readings in this window.</p>
      ) : null}
      {any
        ? drawn.map(({ s, points }) => {
            const thinned = downsample(points);
            const range = valueRange(thinned, s);
            const now = readingAt(thinned, at);
            const state = now ? limitState(now[1], s.limits) : 'normal';
            const note = limitText(state);
            const readout = now
              ? `${formatReading(now[1], s)} at ${formatUtcTime(now[0])}${note ? ` · ${note}` : ''}`
              : 'no reading yet';
            return (
              <figure key={s.key} className="wv-track__profile wv-readings__series" data-series={s.key}>
                <figcaption className="wv-track__caption">
                  <span>
                    <strong>{s.name}</strong> <span className="wv-track__readout wv-num">{readout}</span>
                  </span>
                  {range && points.length ? (
                    <span className="wv-track__legend">
                      {rangeText(range, s)}
                      {points.length > thinned.length ? ` · ${thinned.length} of ${points.length} points` : ''}
                    </span>
                  ) : null}
                </figcaption>
                {points.length && range ? (
                  <div
                    className="wv-track__chart"
                    role="slider"
                    tabIndex={0}
                    aria-label={`${s.name} over the window${onSeek ? ' — Enter shows the world at this moment' : ''}`}
                    aria-valuemin={window.startMs}
                    aria-valuemax={window.endMs}
                    aria-valuenow={Math.round(at)}
                    aria-valuetext={readout}
                    onPointerMove={(e) => setPointer(fromPointer(e))}
                    onPointerLeave={() => setPointer(null)}
                    onClick={(e) => onSeek?.(fromPointer(e))}
                    onKeyDown={onKey}
                  >
                    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                      {limitBands(s.limits, range, H).map((b, i) => (
                        <rect
                          key={i}
                          className={`wv-readings__band wv-readings__band--${b.kind}`}
                          x={0}
                          y={b.y.toFixed(1)}
                          width={W}
                          height={b.height.toFixed(1)}
                          fill={b.kind === 'crit' ? 'var(--wv-danger-soft)' : 'var(--wv-warning-soft)'}
                        />
                      ))}
                      <path
                        className="wv-track__line wv-track__line--altitude"
                        d={readingsPath(
                          thinned,
                          range,
                          window,
                          W,
                          H,
                          gapThreshold(points, stepMs ? stepMs * 1.5 : 60_000),
                        )}
                      />
                      <line className="wv-track__cursor" x1={cursorX} x2={cursorX} y1={0} y2={H} />
                      {pointerX !== undefined ? (
                        <line className="wv-track__cursor" x1={pointerX} x2={pointerX} y1={0} y2={H} />
                      ) : null}
                    </svg>
                  </div>
                ) : (
                  <p className="wv-ctx-muted">No {s.name.toLowerCase()} readings in this window.</p>
                )}
              </figure>
            );
          })
        : null}
      {notes.length ? <p className="wv-ctx-muted wv-readings__note">{notes.join(' · ')}</p> : null}
    </div>
  );
}

/** "a–b units", or one value when both ends read the same. */
function rangeText(range: { min: number; max: number }, s: TelemetrySeries): string {
  const lo = formatReading(range.min, s);
  const hi = formatReading(range.max, s);
  return lo === hi ? lo : `${lo} – ${hi}`;
}
