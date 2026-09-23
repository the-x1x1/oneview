import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { haversineMeters } from '@worldview/world-model';
import {
  Button,
  FieldList,
  formatAltitude,
  formatDistance,
  formatDuration,
  formatSpeed,
  formatUtcDateTime,
  formatUtcTime,
} from '@worldview/ui';
import type { ContextSectionProps } from './registry.js';
import {
  TRACK_WINDOWS,
  profilePath,
  replaySpeedFor,
  sampleAt,
  trackProfile,
  type ProfileSample,
} from './track-profile.js';

const W = 1000;
const H = 100;

/**
 * History for one object: the track summary, then its altitude and ground-speed profiles
 * over the chosen window. Pointing at the profile reads the values at that moment; a click
 * (or Enter) puts the replay cursor there, so the map shows the world as it was; "Replay
 * track" plays it back from the first point. The chart is a slider for the keyboard.
 */
export function TrackHistory({ object, track, actions }: ContextSectionProps) {
  const [windowMs, setWindowMs] = useState(TRACK_WINDOWS[0]!.ms);
  const [pointer, setPointer] = useState<number | null>(null);
  const profile = useMemo(() => trackProfile(track), [track]);
  const units = unitsFor(object.type);

  const first = track[0];
  const last = track[track.length - 1];
  let distance = 0;
  for (let i = 1; i < track.length; i++) distance += haversineMeters(track[i - 1]!, track[i]!);
  const span = first && last ? Date.parse(last.observedAt) - Date.parse(first.observedAt) : 0;

  const chooseWindow = (ms: number) => {
    setWindowMs(ms);
    setPointer(null);
    void actions.loadTrack(object.id, ms);
  };

  const hasChart = profile && (profile.altitude || profile.speed);
  const shown: ProfileSample | undefined = profile ? sampleAt(profile, pointer ?? profile.endMs) : undefined;

  const fromPointer = (e: MouseEvent<HTMLDivElement>) => {
    if (!profile) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const f = rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 1;
    return profile.startMs + f * (profile.endMs - profile.startMs);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!profile) return;
    const step = (profile.endMs - profile.startMs) / 100;
    const at = pointer ?? profile.endMs;
    if (e.key === 'ArrowLeft') setPointer(Math.max(profile.startMs, at - step));
    else if (e.key === 'ArrowRight') setPointer(Math.min(profile.endMs, at + step));
    else if (e.key === 'Home') setPointer(profile.startMs);
    else if (e.key === 'End') setPointer(profile.endMs);
    else if (e.key === 'Enter' || e.key === ' ') actions.seekTo(sampleAt(profile, at).t);
    else return;
    e.preventDefault();
  };

  const readout = shown
    ? [
        formatUtcTime(shown.t),
        shown.altitudeM !== undefined ? units.altitude(shown.altitudeM) : undefined,
        shown.speedMps !== undefined ? `${units.speed(shown.speedMps)} ground speed` : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const cursorX =
    profile && shown ? ((shown.t - profile.startMs) / Math.max(1, profile.endMs - profile.startMs)) * W : 0;

  return (
    <div className="wv-track">
      <div className="wv-track__windows" role="group" aria-label="Track window">
        {TRACK_WINDOWS.map((w) => (
          <button
            key={w.ms}
            type="button"
            className={`wv-track__window${w.ms === windowMs ? ' wv-track__window--on' : ''}`}
            aria-pressed={w.ms === windowMs}
            onClick={() => chooseWindow(w.ms)}
          >
            {w.label}
          </button>
        ))}
      </div>
      <FieldList
        rows={[
          { label: 'Track points', value: String(track.length) },
          { label: 'Span', value: formatDuration(span) },
          { label: 'Distance', value: formatDistance(distance) },
          { label: 'From', value: first ? formatUtcDateTime(first.observedAt) : '—' },
          { label: 'To', value: last ? formatUtcDateTime(last.observedAt) : '—' },
        ]}
      />
      {hasChart && profile ? (
        <figure className="wv-track__profile">
          <div
            className="wv-track__chart"
            role="slider"
            tabIndex={0}
            aria-label="Track profile — Enter shows the world at this moment"
            aria-valuemin={profile.startMs}
            aria-valuemax={profile.endMs}
            aria-valuenow={shown?.t ?? profile.endMs}
            aria-valuetext={readout}
            onPointerMove={(e) => setPointer(fromPointer(e))}
            onPointerLeave={() => setPointer(null)}
            onClick={(e) => {
              const t = fromPointer(e);
              if (t !== null) actions.seekTo(sampleAt(profile, t).t);
            }}
            onKeyDown={onKey}
          >
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
              {profile.altitude ? (
                <path
                  className="wv-track__line wv-track__line--altitude"
                  d={profilePath(profile, (s) => s.altitudeM, profile.altitude, W, H)}
                />
              ) : null}
              {profile.speed ? (
                <path
                  className="wv-track__line wv-track__line--speed"
                  d={profilePath(profile, (s) => s.speedMps, profile.speed, W, H)}
                />
              ) : null}
              <line className="wv-track__cursor" x1={cursorX} x2={cursorX} y1={0} y2={H} />
            </svg>
          </div>
          <figcaption className="wv-track__caption">
            <span className="wv-track__readout wv-num">{readout}</span>
            <span className="wv-track__legend">
              {profile.altitude ? (
                <span className="wv-track__key wv-track__key--altitude">
                  Altitude {rangeText(profile.altitude, units.altitude)}
                </span>
              ) : null}
              {profile.speed ? (
                <span className="wv-track__key wv-track__key--speed">
                  Ground speed {rangeText(profile.speed, units.speed)}, from positions
                </span>
              ) : null}
            </span>
          </figcaption>
        </figure>
      ) : null}
      {profile ? (
        <div className="wv-ctx-actions">
          <Button
            size="sm"
            variant="ghost"
            icon="history"
            onClick={() => actions.replayFrom(profile.startMs, replaySpeedFor(profile.endMs - profile.startMs))}
          >
            Replay track
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** "a–b", or one value when both ends read the same. */
function rangeText(r: { min: number; max: number }, fmt: (v: number) => string): string {
  const lo = fmt(r.min);
  const hi = fmt(r.max);
  return lo === hi ? lo : `${lo}–${hi}`;
}

function unitsFor(type: string): { altitude: (m: number) => string; speed: (mps: number) => string } {
  if (type === 'satellite')
    return {
      altitude: (m) => `${Math.round(m / 1000).toLocaleString('en-US')} km`,
      speed: (mps) => `${(mps / 1000).toFixed(2)} km/s`,
    };
  const alt = type === 'aircraft' ? 'ft' : 'm';
  const speed = type === 'aircraft' || type === 'vessel' ? 'kt' : 'km/h';
  return {
    altitude: (m) => formatAltitude(m, alt) ?? '—',
    speed: (mps) => formatSpeed(mps, speed) ?? '—',
  };
}
