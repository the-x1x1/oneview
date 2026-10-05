import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, EmptyState, LoadingState, Panel, Toggle } from '@worldview/ui';
import type { SkyOverheadAnswer } from '@worldview/ipc-contract';
import { resolveStyle } from '@worldview/render-core';
import { moonPosition, sunPosition, type GeoPosition } from '@worldview/world-model';
import { useActions, useAppState } from '../store/store.js';
import { useNow } from '../hooks/use-now.js';
import { pastShownAtMs } from '../store/shown-time.js';
import { PLOT_RADIUS, lookText, polarXY, skySummary, visibleToEye } from './sky-plot.js';

/** How often the sky is asked for again while the tab is open. */
const REFRESH_MS = 5_000;
/** The middle of the map is asked about once it has rested this long (not on every frame of a pan). */
const SETTLE_MS = 600;
/**
 * …and at least this often while it keeps moving: following a low orbit moves the middle of
 * the map every quarter second, and a pure wait would never end.
 */
const SETTLE_MAX_MS = 5_000;
/** Rows listed under the plot until "Show all". */
const LISTED = 30;
/** The most the runtime is asked for (its own cap). */
const ASKED = 500;

type Over = 'home' | 'view';

/** The last answer, so the tab opened again shows the sky at once (asked again straight after). */
let lastAnswer: SkyOverheadAnswer | undefined;
/** The filters it was asked with, kept with it so the tab opened again matches what it shows. */
let lastFilters = { hideStarlink: false, onlyVisible: false };
/** Keep an answer as the last one (the tab keeps its own; tests seed one). */
export function rememberSkyAnswer(answer: SkyOverheadAnswer | undefined): void {
  lastAnswer = answer;
}

const fold = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
const place = (p: GeoPosition) =>
  `${Math.abs(p.latitude).toFixed(2)}° ${p.latitude >= 0 ? 'N' : 'S'}, ${Math.abs(p.longitude).toFixed(2)}° ${p.longitude >= 0 ? 'E' : 'W'}`;
const keyOf = (p: GeoPosition) => `${p.latitude.toFixed(2)},${p.longitude.toFixed(2)}`;
const fromKey = (k: string): GeoPosition => {
  const [lat, lon] = k.split(',').map(Number);
  return { latitude: lat ?? 0, longitude: lon ?? 0 };
};
const hhmm = (iso: string) => new Date(Date.parse(iso)).toISOString().slice(11, 16);

/**
 * Sky tab: the satellites above the horizon now, from your home view or the middle of the map,
 * on a polar plot (the zenith in the middle, north up, east right) with the Sun and the Moon,
 * and the highest listed — each lit or in the Earth's shadow, and which could be seen with
 * the eye. Worked out by the runtime from the live satellites' propagated positions
 * (`sky.overhead`), with the filters applied there before anything is counted or cut; picking
 * one selects it. It is always the sky now: replaying, it says so.
 */
export function SkyPanel() {
  const { session, world, timeline } = useAppState();
  const actions = useActions();
  const home = session.settings?.home?.view;
  // Home unless the middle of the map was chosen — and the middle of the map while there is no
  // home view (settings still loading, or the home view cleared).
  const [chosen, setOver] = useState<Over | undefined>(undefined);
  const over: Over = home && chosen !== 'view' ? 'home' : 'view';
  const [hideStarlink, setHideStarlink] = useState(lastFilters.hideStarlink);
  const [onlyVisible, setOnlyVisible] = useState(lastFilters.onlyVisible);
  const [showAll, setShowAll] = useState(false);
  const [answer, setAnswer] = useState<SkyOverheadAnswer | undefined>(lastAnswer);
  const [failed, setFailed] = useState(false);
  const nowMs = useNow(REFRESH_MS);

  const centre = world.view.focus ?? world.view.center;
  const key = keyOf(
    over === 'home' && home
      ? { latitude: home.latitude, longitude: home.longitude }
      : { latitude: centre.latitude, longitude: fold(centre.longitude) },
  );
  // The place asked about: home at once, the middle of the map once it has rested (or every
  // few seconds while it does not).
  const [settled, setSettled] = useState(key);
  const settledAt = useRef(Date.now());
  useEffect(() => {
    if (key === settled) return undefined;
    const wait = over === 'home' ? 0 : Math.max(0, Math.min(SETTLE_MS, settledAt.current + SETTLE_MAX_MS - Date.now()));
    const t = setTimeout(() => {
      settledAt.current = Date.now();
      setSettled(key);
    }, wait);
    return () => clearTimeout(t);
  }, [key, settled, over]);

  useEffect(() => {
    let live = true;
    void actions.skyOverhead(fromKey(settled), { limit: ASKED, hideStarlink, visibleOnly: onlyVisible }).then((a) => {
      if (!live) return;
      // A failed ask keeps the last sky (and says so) rather than blanking the tab.
      setFailed(!a);
      if (!a) return;
      lastAnswer = a;
      lastFilters = { hideStarlink, onlyVisible };
      setAnswer(a);
    });
    return () => {
      live = false;
    };
  }, [actions, settled, nowMs, hideStarlink, onlyVisible]);

  const chooser = (
    <div className="wv-sky__over" role="group" aria-label="Seen from">
      <Button
        size="sm"
        variant="ghost"
        pressed={over === 'home'}
        disabled={!home}
        title={home ? 'From your home view' : 'Set a home view in Settings to see the sky from it'}
        onClick={() => setOver('home')}
      >
        Home
      </Button>
      <Button size="sm" variant="ghost" pressed={over === 'view'} onClick={() => setOver('view')}>
        Middle of the map
      </Button>
    </div>
  );
  const frame = (subtitle: string | undefined, body: ReactNode) => (
    <Panel title="Sky" {...(subtitle ? { subtitle } : {})} actions={chooser}>
      {body}
    </Panel>
  );

  if (!answer)
    return frame(
      undefined,
      failed ? (
        <EmptyState
          icon="satellite"
          title="The sky could not be worked out"
          description="The runtime did not answer; it is asked again in a few seconds."
          compact
        />
      ) : (
        <LoadingState label="Working out the sky" />
      ),
    );

  const shown = answer.satellites;
  // The answer's own place and time: the one shown may be from before the place changed.
  const seenFrom = answer.observer;
  const at = Date.parse(answer.at);
  const sun = sunPosition(at, seenFrom);
  const moon = moonPosition(at, seenFrom);
  const dark = answer.sunElevationDeg <= -6;
  const colour = (category: string | undefined) =>
    resolveStyle({ styleClass: category ? `satellite.${category}` : 'satellite' }).colorCss;
  const R = PLOT_RADIUS;
  const listed = showAll ? shown : shown.slice(0, LISTED);
  const replaying = pastShownAtMs(timeline.control) !== undefined;

  return frame(
    `Above ${place(seenFrom)} at ${hhmm(answer.at)} UTC · ${skySummary(answer)}`,
    <div className="wv-sky">
      {replaying ? (
        <p className="wv-ctx-muted">
          The sky now, live: the timeline is showing another time, and satellites are not worked out for it here.
        </p>
      ) : null}
      {failed ? <p className="wv-ctx-muted">Not answered just now: this is the sky at {hhmm(answer.at)} UTC.</p> : null}
      {answer.stale > 0 ? (
        <p className="wv-ctx-muted">
          {answer.stale.toLocaleString('en-US')} more near this sky {answer.stale === 1 ? 'is' : 'are'} left out: the
          satellite source has not worked out {answer.stale === 1 ? 'its position' : 'their positions'} for over a
          minute (Sources).
        </p>
      ) : null}
      <svg
        className="wv-sky__plot"
        viewBox={`${-R - 14} ${-R - 14} ${2 * R + 28} ${2 * R + 28}`}
        role="img"
        aria-label={`Sky plot from ${place(seenFrom)}: ${shown.length} satellite${shown.length === 1 ? '' : 's'} drawn; the list below names them.`}
      >
        <circle r={R} className="wv-sky__ring wv-sky__ring--horizon" />
        <circle r={(R * 60) / 90} className="wv-sky__ring" />
        <circle r={(R * 30) / 90} className="wv-sky__ring" />
        <line x1={-R} y1={0} x2={R} y2={0} className="wv-sky__ring" />
        <line x1={0} y1={-R} x2={0} y2={R} className="wv-sky__ring" />
        {(
          [
            ['N', 0, -R - 6],
            ['E', R + 7, 0],
            ['S', 0, R + 10],
            ['W', -R - 7, 0],
          ] as const
        ).map(([t, x, y]) => (
          <text key={t} x={x} y={y} className="wv-sky__compass" textAnchor="middle" dominantBaseline="middle">
            {t}
          </text>
        ))}
        <text x={3} y={(-R * 30) / 90 + 9} className="wv-sky__ring-label">
          60°
        </text>
        <text x={3} y={(-R * 60) / 90 + 9} className="wv-sky__ring-label">
          30°
        </text>
        {shown.map((s) => {
          const p = polarXY(s.azimuthDeg, s.elevationDeg);
          const eye = visibleToEye(s, answer.sunElevationDeg);
          return (
            <circle
              key={s.id}
              cx={p.x}
              cy={p.y}
              r={eye ? 3 : 2}
              fill={colour(s.category)}
              opacity={s.sunlit ? 1 : 0.4}
              className="wv-sky__dot"
              onClick={() => void actions.select(s.id, { kind: 'object', fly: false })}
            >
              <title>{`${s.name} — ${lookText(s)}${s.sunlit ? ', sunlit' : ", in the Earth's shadow"}`}</title>
            </circle>
          );
        })}
        {sun.altitudeDeg > 0 ? (
          <circle {...cxcy(polarXY(sun.azimuthDeg, sun.altitudeDeg))} r={6} className="wv-sky__sun">
            <title>{`The Sun, ${Math.round(sun.altitudeDeg)}° up`}</title>
          </circle>
        ) : null}
        {moon.altitudeDeg > 0 ? (
          <circle {...cxcy(polarXY(moon.azimuthDeg, moon.altitudeDeg))} r={5} className="wv-sky__moon">
            <title>{`The Moon, ${Math.round(moon.altitudeDeg)}° up`}</title>
          </circle>
        ) : null}
      </svg>
      <div className="wv-sky__filters">
        <Toggle size="sm" checked={hideStarlink} onChange={setHideStarlink} label="Leave out Starlink" />
        <Toggle
          size="sm"
          checked={onlyVisible}
          onChange={setOnlyVisible}
          label="Only those you could see"
          description={
            dark
              ? 'Sunlit, 10° up or more, the sky dark.'
              : 'The sky is not dark here now (the Sun less than 6° down): none can be seen.'
          }
        />
      </div>
      {shown.length ? (
        <ul className="wv-related" aria-label="Satellites above the horizon, highest first">
          {listed.map((s) => (
            <li key={s.id} className="wv-related__item">
              <button
                type="button"
                className="wv-related__button"
                onClick={() => void actions.select(s.id, { kind: 'object', fly: false })}
              >
                <span className="wv-related__title wv-truncate">
                  <span className="wv-sky__swatch" style={{ background: colour(s.category) }} aria-hidden="true" />
                  {s.name}
                </span>
                <span className="wv-related__meta">
                  {lookText(s)}
                  {visibleToEye(s, answer.sunElevationDeg)
                    ? ' · could be seen'
                    : s.sunlit
                      ? ' · sunlit'
                      : " · in the Earth's shadow"}
                </span>
              </button>
            </li>
          ))}
          {shown.length > LISTED ? (
            <li className="wv-related__heading">
              <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
                {showAll ? `Only the highest ${LISTED}` : `Show all ${shown.length}`}
              </Button>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="wv-ctx-muted">
          {onlyVisible ? 'None can be seen with the eye from here now.' : 'No satellite is above the horizon here now.'}
        </p>
      )}
      {answer.total > shown.length && !onlyVisible ? (
        <p className="wv-ctx-muted">
          The highest {shown.length.toLocaleString('en-US')} of {answer.total.toLocaleString('en-US')} are drawn.
        </p>
      ) : null}
      <p className="wv-ctx-muted">
        From the positions the satellite source last worked out (SGP4 from CelesTrak's element sets, for the groups it
        loads), carried to now. A dim dot is in the Earth's shadow; a bright one in a dark sky could be seen.
      </p>
    </div>,
  );
}

function cxcy(p: { x: number; y: number }): { cx: number; cy: number } {
  return { cx: p.x, cy: p.y };
}
