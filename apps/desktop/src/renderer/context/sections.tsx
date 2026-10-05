import { useEffect, useState } from 'react';
import type { WorldObject } from '@worldview/world-model';
import type { CameraPictureHealth, CameraStreamDescriptor } from '@worldview/ipc-contract';
import {
  Button,
  FieldList,
  StatusBadge,
  formatAgo,
  formatAltitude,
  formatDepthKm,
  formatDuration,
  formatRelativeAge,
  formatUtcDateTime,
} from '@worldview/ui';
import {
  CYCLONE_CATEGORY_NAMES,
  cycloneCategory,
  cycloneOf,
  satelliteCategoryLabel,
  satelliteCategoryPurpose,
} from '@worldview/render-core';
import { contextRegistry, type ContextSection } from './registry.js';
import { bool, num, safeHttpsUrl, str, strList } from './props.js';
import type { ShellActions } from '../store/actions.js';
import { readMjpeg } from './mjpeg.js';
import { SatelliteKnowledge } from './satellite-details.js';
import { feltText, intensityText, magnitudeText, pagerText, vesselRows } from './object-knowledge.js';
import { cpa, cpaText } from './cpa.js';
import { AircraftDetails } from './flight.js';
import { useAppState } from '../store/store.js';

/**
 * Type-specific context sections (directive §62). Property names follow the provider
 * normalizers' payload conventions (e.g. providers/usgs/src/normalize.ts). Sections
 * return null when the object carries none of their fields, so no empty headings render.
 */

/** A satellite CelesTrak can be asked about: a NORAD id as a number (CelesTrak) or a string. */
export function hasNoradId(object: WorldObject): boolean {
  const v = object.properties['noradId'];
  return (typeof v === 'number' && Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^\d+$/.test(v.trim()));
}

const aircraft: ContextSection = {
  id: 'aircraft',
  title: 'Aircraft',
  // Flight, route, progress and the aircraft itself (flight.tsx).
  render: ({ object, flight, actions, nowMs }) => (
    <AircraftDetails object={object} flight={flight ?? null} actions={actions} nowMs={nowMs} />
  ),
};

const earthquake: ContextSection = {
  id: 'earthquake',
  title: 'Earthquake',
  render: ({ object, actions }) => {
    const detail = safeHttpsUrl(str(object, 'detailUrl'));
    const tsunami = bool(object, 'tsunami');
    const updated = str(object, 'updatedAt');
    const mmi = intensityText(num(object, 'mmi'));
    return (
      <div className="wv-ctx-stack">
        <FieldList
          rows={[
            { label: 'Magnitude', value: magnitudeText(num(object, 'magnitude'), str(object, 'magType')) },
            { label: 'Depth', value: formatDepthKm(num(object, 'depthKm')) },
            { label: 'Place', value: str(object, 'place') },
            {
              label: 'Tsunami',
              // USGS sets the flag for large events in oceanic regions; its documentation says
              // the flag does not mean a tsunami did or will happen. The warning centres say that.
              value:
                tsunami === undefined
                  ? undefined
                  : tsunami
                    ? 'Flag set: a large event in an oceanic region. Not a tsunami warning; see the tsunami warning centres'
                    : 'No tsunami flag',
            },
            { label: 'PAGER alert', value: pagerText(str(object, 'alert')) },
            { label: 'Felt reports', value: feltText(num(object, 'felt'), num(object, 'cdi')) },
            { label: 'Shaking (ShakeMap)', value: mmi ? `Intensity ${mmi} at the strongest` : undefined },
            { label: 'Status', value: str(object, 'status') },
            { label: 'Event type', value: str(object, 'eventType') },
            { label: 'Significance', value: num(object, 'significance')?.toLocaleString('en-US') },
            {
              label: 'Stations',
              value: num(object, 'stations') !== undefined ? String(num(object, 'stations')) : undefined,
            },
            { label: 'Network', value: str(object, 'network'), mono: true },
            { label: 'Updated', value: updated ? formatUtcDateTime(updated) : undefined },
            { label: 'Aliases', value: strList(object, 'aliases')?.join(', '), mono: true },
          ]}
        />
        {detail ? (
          <Button size="sm" icon="external" onClick={() => void actions.openExternal(detail)}>
            USGS event page
          </Button>
        ) : null}
      </div>
    );
  },
};

const satellite: ContextSection = {
  id: 'satellite',
  title: 'Orbit',
  render: ({ object, actions, nowMs }) => {
    const period = num(object, 'periodMinutes');
    const epoch = str(object, 'epoch');
    // CelesTrak's element sets say `inclination`; the recorded demo world says `inclinationDeg`.
    const inclination = num(object, 'inclination') ?? num(object, 'inclinationDeg');
    const apogee = num(object, 'apogeeKm');
    const perigee = num(object, 'perigeeKm');
    const purpose = satelliteCategoryPurpose(object.properties['satelliteCategory']);
    return (
      <div className="wv-ctx-stack">
        <FieldList
          rows={[
            { label: 'NORAD ID', value: str(object, 'noradId') ?? object.id.split(':')[2], mono: true },
            { label: 'Intl designator', value: str(object, 'intlDesignator'), mono: true },
            { label: 'Epoch', value: epoch ? formatUtcDateTime(epoch) : undefined },
            { label: 'Period', value: period !== undefined ? formatDuration(period * 60_000) : undefined },
            { label: 'Altitude', value: formatAltitude(object.position?.altitudeM, 'm') },
            { label: 'Inclination', value: inclination !== undefined ? `${inclination.toFixed(2)}°` : undefined },
            {
              label: 'Perigee / apogee',
              value:
                perigee !== undefined && apogee !== undefined
                  ? `${Math.round(perigee).toLocaleString('en-US')} / ${Math.round(apogee).toLocaleString('en-US')} km`
                  : undefined,
            },
            { label: 'Category', value: satelliteCategoryLabel(object.properties['satelliteCategory']) },
            { label: 'Group', value: str(object, 'group') },
          ]}
        />
        {purpose ? <p className="wv-ctx-summary">{purpose}</p> : null}
        {/* The catalogue record and passes are asked for (world.details) for any satellite with
            a NORAD id. The test was meanMotion or a string noradId: the page gets satellites
            without their element sets (event-wire.ts) and CelesTrak's noradId is a number, so
            from 2026-09-23 no live satellite showed it (found on the laptop, 2026-10-03). The
            recorded demo world has no source to ask: SatelliteKnowledge shows nothing there. */}
        {hasNoradId(object) ? <SatelliteKnowledge object={object} actions={actions} nowMs={nowMs} /> : null}
      </div>
    );
  },
};

const fireDetection: ContextSection = {
  id: 'fire-detection',
  title: 'Fire detection',
  render: ({ object }) => (
    <FieldList
      rows={[
        {
          label: 'Brightness',
          value: num(object, 'brightnessK') !== undefined ? `${num(object, 'brightnessK')!.toFixed(1)} K` : undefined,
        },
        {
          label: 'FRP',
          value: num(object, 'frpMw') !== undefined ? `${num(object, 'frpMw')!.toFixed(1)} MW` : undefined,
        },
        {
          label: 'Detection confidence',
          value:
            str(object, 'confidenceClass') ??
            (num(object, 'confidencePct') !== undefined ? `${num(object, 'confidencePct')}%` : undefined),
        },
        { label: 'Satellite', value: str(object, 'satellite') },
        { label: 'Instrument', value: str(object, 'instrument') },
        { label: 'Day / night', value: str(object, 'dayNight') },
        {
          label: 'Acquired',
          value: str(object, 'acquiredAt') ? formatUtcDateTime(str(object, 'acquiredAt')) : undefined,
        },
      ]}
    />
  ),
};

/** Saffir–Simpson category from 1-minute sustained wind in knots (NHC's thresholds), or undefined below hurricane strength. */
export function saffirSimpson(kt: number): number | undefined {
  return kt >= 137 ? 5 : kt >= 113 ? 4 : kt >= 96 ? 3 : kt >= 83 ? 2 : kt >= 64 ? 1 : undefined;
}

/**
 * "232 km/h (144 mph, 125 kt) · Category 4 equivalent" — GDACS gives km/h. The category is an
 * equivalent on the Saffir–Simpson scale: GDACS takes its winds from the warning centre of
 * the basin, and not every centre averages over one minute as NHC does.
 */
export function cycloneWind(kmh: number | undefined): string | undefined {
  if (kmh === undefined || kmh <= 0) return undefined;
  const kt = Math.round(kmh / 1.852);
  const cat = saffirSimpson(kt);
  return `${Math.round(kmh)} km/h (${Math.round(kmh / 1.609344)} mph, ${kt} kt)${cat ? ` · Category ${cat} equivalent` : ''}`;
}

/** NHC storm type codes, for a stretch of past track or a forecast position. */
const STORM_TYPES: Readonly<Record<string, string>> = Object.freeze({
  DB: 'Disturbance',
  LO: 'Low',
  WV: 'Tropical wave',
  TD: 'Tropical depression',
  STD: 'Subtropical depression',
  TS: 'Tropical storm',
  STS: 'Subtropical storm',
  HU: 'Hurricane',
  MH: 'Major hurricane',
  EX: 'Extratropical',
  PTC: 'Post-tropical cyclone',
});

/** "110 kt (127 mph) · Category 3 (major)" — a forecast wind with the category it would be. */
export function forecastWind(kt: number | undefined): string | undefined {
  if (kt === undefined || kt < 0) return undefined;
  return `${kt} kt (${Math.round(kt * 1.15078)} mph) · ${CYCLONE_CATEGORY_NAMES[cycloneCategory(kt)]}`;
}

/** "NE 30 · SE 25 · SW 20 · NW 30 nm" — how far a wind speed reaches in each quadrant. */
export function quadrantRadii(ne?: number, se?: number, sw?: number, nw?: number): string | undefined {
  const all: Array<[string, number | undefined]> = [
    ['NE', ne],
    ['SE', se],
    ['SW', sw],
    ['NW', nw],
  ];
  const parts = all.filter((q): q is [string, number] => q[1] !== undefined);
  if (!parts.length) return undefined;
  return `${parts.map(([q, v]) => `${q} ${v}`).join(' · ')} nm (${parts.map(([, v]) => Math.round(v * 1.852)).join('/')} km)`;
}

/**
 * The rows NHC's storm layers add to an alert (connectors/enabled nhc-forecast-points,
 * nhc-past-track, nhc-wind-field; render-core storm-style.ts): a forecast position's time,
 * what the storm is expected to be then, its wind, gusts and pressure; a stretch of past
 * track's strength; the wind field's reach by quadrant. Nothing for any other alert.
 */
export function cycloneRows(object: WorldObject): Array<{ label: string; value: string | undefined }> {
  const layer = str(object, 'cycloneLayer');
  if (layer === 'forecast-point') {
    const date = str(object, 'forecastDate') ?? str(object, 'forecastTime');
    const hours = num(object, 'forecastHours');
    const mb = num(object, 'forecastPressureMb');
    const gust = num(object, 'gustKt');
    return [
      { label: 'Forecast for', value: date ? `${date}${hours !== undefined ? ` (+${hours} h)` : ''}` : undefined },
      { label: 'Expected as', value: str(object, 'forecastClass') ?? STORM_TYPES[str(object, 'stormType') ?? ''] },
      { label: 'Sustained winds', value: forecastWind(num(object, 'intensityKt')) },
      { label: 'Gusts', value: gust !== undefined ? `${gust} kt (${Math.round(gust * 1.15078)} mph)` : undefined },
      // 9999 is NHC's "not forecast": pressure is given for the current position only.
      { label: 'Pressure', value: mb !== undefined && mb > 800 && mb < 1100 ? `${mb} mb` : undefined },
    ];
  }
  if (layer === 'past-track') {
    const ss = Number(str(object, 'trackCategory'));
    const type = STORM_TYPES[str(object, 'stormType') ?? ''];
    const hurricane =
      Number.isInteger(ss) && ss >= 1 && ss <= 5
        ? CYCLONE_CATEGORY_NAMES[`cat${ss}` as keyof typeof CYCLONE_CATEGORY_NAMES]
        : undefined;
    return [{ label: 'Strength here', value: hurricane ? `Hurricane, ${hurricane}` : type }];
  }
  if (layer === 'wind-field') {
    const kt = num(object, 'windRadiiKt');
    const reach = quadrantRadii(
      num(object, 'radiusNeNm'),
      num(object, 'radiusSeNm'),
      num(object, 'radiusSwNm'),
      num(object, 'radiusNwNm'),
    );
    return [
      {
        label: 'Wind field',
        value:
          kt !== undefined
            ? `${kt} kt sustained${kt === 34 ? ' (tropical-storm force)' : kt === 64 ? ' (hurricane force)' : ''}`
            : undefined,
      },
      { label: 'Reaches', value: reach },
    ];
  }
  return [];
}

/** SPC categorical risk, with its place on the five-level severe scale. */
const SPC_RISK: Readonly<Record<string, string>> = Object.freeze({
  TSTM: 'General thunderstorms (no severe risk)',
  MRGL: 'Marginal (1 of 5)',
  SLGT: 'Slight (2 of 5)',
  ENH: 'Enhanced (3 of 5)',
  MDT: 'Moderate (4 of 5)',
  HIGH: 'High (5 of 5)',
});

/** What an NWS damage-threat tag means, in the warning's own words. */
const DAMAGE_THREAT: Readonly<Record<string, string>> = Object.freeze({
  CONSIDERABLE: 'Considerable — a particularly dangerous situation',
  CATASTROPHIC: 'Catastrophic — an emergency',
  DESTRUCTIVE: 'Destructive',
  BASE: 'Base',
});

const titleCase = (v: string) => v.charAt(0) + v.slice(1).toLowerCase();

/**
 * The rows a hazard area adds to an alert (connectors/enabled: NIFC perimeters, NHC forecast
 * cones and tracks, GDACS alerts, NWS storm reports, the SPC outlook; the NWS provider's
 * storm-based warning tags). Each is absent unless its source writes the key, so an alert
 * without them shows exactly what it showed before.
 */
export function hazardRows(
  object: WorldObject,
  nowMs: number = Date.now(),
): Array<{ label: string; value: string | undefined }> {
  const acres = num(object, 'areaAcres');
  const contained = num(object, 'percentContained');
  const onset = str(object, 'onset');
  const advisory = str(object, 'advisoryNumber');
  const advisoryDate = str(object, 'advisoryDate');
  const level = str(object, 'alertLevel');
  const episode = str(object, 'episodeAlertLevel');
  const magnitude = str(object, 'magnitude');
  const units = str(object, 'magnitudeUnits');
  const detection = str(object, 'tornadoDetection');
  const threat = str(object, 'damageThreat');
  const hail = str(object, 'maxHailSize');
  const category = str(object, 'spcCategory');
  const reported = str(object, 'reportedAt');
  return [
    {
      label: 'Alert level',
      value: level ? (episode && episode !== level ? `${level} (this episode ${episode})` : level) : undefined,
    },
    { label: 'Impact', value: str(object, 'severityText') },
    // GDACS's figure is the most the storm has reached, not its wind now.
    { label: 'Peak wind (its life so far)', value: cycloneWind(num(object, 'maxWindKmh')) },
    ...cycloneRows(object),
    { label: 'Risk', value: category ? (SPC_RISK[category] ?? category) : undefined },
    { label: 'Tornado', value: detection ? titleCase(detection) : undefined },
    { label: 'Damage threat', value: threat ? (DAMAGE_THREAT[threat] ?? titleCase(threat)) : undefined },
    { label: 'Wind gusts to', value: str(object, 'maxWindGust') },
    { label: 'Hail up to', value: hail ? `${hail}${/^[\d.]+$/.test(hail) ? ' in' : ''}` : undefined },
    { label: 'Report', value: str(object, 'reportType') },
    {
      label: 'Magnitude',
      value: magnitude ? `${magnitude}${units ? ` ${units.toLowerCase() === 'inch' ? 'in' : units}` : ''}` : undefined,
    },
    { label: 'Reported', value: reported ? formatUtcDateTime(reported) : undefined },
    {
      label: 'Burned area',
      value: acres !== undefined ? `${acres.toLocaleString('en-US', { maximumFractionDigits: 1 })} acres` : undefined,
    },
    { label: 'Contained', value: contained !== undefined ? `${contained}%` : undefined },
    // A fire's discovery has happened; an NWS warning's onset can be a forecast (a river expected
    // to flood tomorrow), and "Began" beside a future time read as wrong (2026-10-03).
    {
      label: onset && Date.parse(onset) > nowMs ? 'Expected from' : 'Began',
      value: onset ? formatUtcDateTime(onset) : undefined,
    },
    { label: 'Advisory', value: advisory ? `${advisory}${advisoryDate ? ` · ${advisoryDate}` : ''}` : undefined },
  ];
}

/**
 * When an alert is in force, as its sender said: NWS sends `ends`, when the hazard ends, and
 * `expires`, when this message does — a watch for Sunday is reissued long before Sunday. The
 * panel showed only `expires`, so a Fire Weather Watch "until October 5 at 6:00 PM MDT"
 * read "Expires … (in 16h)" on 2026-10-03. `ends` is the window's end; `expires` is shown
 * beside it as the message's own expiry only when the two differ.
 */
export function alertWindowRows(
  object: WorldObject,
  nowMs: number = Date.now(),
): Array<{ label: string; value: string | undefined }> {
  const when = (iso: string) =>
    `${formatUtcDateTime(iso)} (${Date.parse(iso) > nowMs ? 'in ' + formatDuration(Date.parse(iso) - nowMs) : 'ended ' + formatAgo(iso, nowMs)})`;
  const effective = str(object, 'effective');
  const ends = str(object, 'ends');
  const expires = str(object, 'expires');
  const rows: Array<{ label: string; value: string | undefined }> = [
    { label: 'Effective', value: effective ? formatUtcDateTime(effective) : undefined },
  ];
  if (ends) rows.push({ label: 'Until', value: when(ends) });
  if (expires && (!ends || Date.parse(expires) !== Date.parse(ends)))
    rows.push({ label: ends ? 'Message expires' : 'Expires', value: when(expires).replace('ended ', 'expired ') });
  return rows;
}

const weatherAlert: ContextSection = {
  id: 'weather-alert',
  title: 'Alert',
  render: ({ object, nowMs, actions }) => {
    const severity = str(object, 'severity');
    // A source page for the alert (a GDACS report); main opens only hosts a manifest names.
    const detail = safeHttpsUrl(str(object, 'detailUrl'));
    return (
      <div className="wv-ctx-stack">
        {severity && ['INFO', 'MINOR', 'MODERATE', 'SEVERE', 'EXTREME'].includes(severity) ? (
          <StatusBadge kind="severity" value={severity as 'INFO' | 'MINOR' | 'MODERATE' | 'SEVERE' | 'EXTREME'} />
        ) : null}
        <FieldList
          rows={[
            { label: 'Event', value: str(object, 'event') },
            { label: 'Headline', value: str(object, 'headline') },
            { label: 'Area', value: str(object, 'areaDesc') },
            ...hazardRows(object, nowMs),
            { label: 'Urgency', value: str(object, 'urgency') },
            { label: 'Certainty', value: str(object, 'certainty') },
            { label: 'Sender', value: str(object, 'senderName') },
            ...alertWindowRows(object, nowMs),
          ]}
        />
        {str(object, 'instruction') ? <p className="wv-ctx-instruction">{str(object, 'instruction')}</p> : null}
        {str(object, 'description') ? <p className="wv-ctx-description">{str(object, 'description')}</p> : null}
        {detail ? (
          <Button size="sm" icon="external" onClick={() => void actions.openExternal(detail)}>
            Source page
          </Button>
        ) : null}
      </div>
    );
  },
};

/** The id the camera gateway knows a camera object by (camera.snapshot, camera.stream). */
export function cameraIdOf(object: WorldObject): string {
  return (
    str(object, 'cameraId') ??
    object.media?.find((m) => m.kind === 'snapshot' || m.kind === 'stream')?.ref ??
    object.id.split(':').slice(2).join(':')
  );
}

/**
 * What the bar under a still says about its time. A public camera's still is replaced by
 * the agency every minute or ten, so the time it was fetched is not the time it shows:
 * the host's own image time is used when it sends one, and its age is said when it is
 * more than a minute; otherwise the label says plainly that only the fetch time is known.
 */
export function captureLabel(state: {
  capturedAt: string | null;
  source?: 'upstream' | 'fetched';
  fetchedAtMs?: number;
}): string {
  if (!state.capturedAt) return '';
  const at = formatUtcDateTime(state.capturedAt);
  if (state.source === 'fetched') return `Fetched ${at} · the source publishes no capture time`;
  const ageMs = state.fetchedAtMs !== undefined ? state.fetchedAtMs - Date.parse(state.capturedAt) : 0;
  // The host's time is when it posted the image (Last-Modified, or the catalogue's own
  // stamp), which can trail the moment the camera took it: a Hong Kong still burned in
  // 16:39 was posted 16:44. "Posted" says what the time is; "Captured" claimed more.
  if (state.source === 'upstream')
    return ageMs >= 60_000 ? `Posted ${at} · ${formatRelativeAge(ageMs)} old when fetched` : `Posted ${at}`;
  return `Captured ${at}`;
}

/** Fetches a snapshot through camera.snapshot and shows the bytes as an object URL (revoked on change/unmount). */
function CameraSnapshotView({
  cameraId,
  actions,
  pollMs,
  onFetched,
}: {
  cameraId: string;
  actions: ShellActions;
  pollMs?: number;
  /** After each attempt, whatever came of it (the Camera section re-reads the picture health). */
  onFetched?: () => void;
}) {
  const [state, setState] = useState<{
    url: string | null;
    capturedAt: string | null;
    /** How far to believe `capturedAt` (CameraSnapshot.capturedAtSource), and when we fetched. */
    source?: 'upstream' | 'fetched';
    fetchedAtMs?: number;
    status: 'idle' | 'loading' | 'error';
    message?: string;
  }>({ url: null, capturedAt: null, status: 'idle' });
  const [nonce, setNonce] = useState(0);

  // A polled still is the closest this build gets to live for snapshot-only cameras;
  // the interval stops with the component, so nothing keeps fetching in the background.
  useEffect(() => {
    if (!pollMs) return undefined;
    const timer = setInterval(() => setNonce((n) => n + 1), pollMs);
    return () => clearInterval(timer);
  }, [pollMs]);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setState((s) => ({ ...s, status: 'loading' }));
    void actions.cameraSnapshot(cameraId).then((snap) => {
      if (cancelled) return;
      onFetched?.();
      if ('error' in snap) {
        // The reason, not only that it failed: "upstream timed out", "unknown camera id".
        setState({ url: null, capturedAt: null, status: 'error', message: `No picture: ${snap.error}` });
        return;
      }
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        setState({
          url: null,
          capturedAt: snap.capturedAt,
          status: 'error',
          message: 'Image display unavailable in this environment',
        });
        return;
      }
      const bytes = new Uint8Array(snap.bytes.byteLength);
      bytes.set(snap.bytes);
      url = URL.createObjectURL(new Blob([bytes], { type: snap.mimeType }));
      setState({
        url,
        capturedAt: snap.capturedAt,
        ...(snap.capturedAtSource ? { source: snap.capturedAtSource } : {}),
        fetchedAtMs: Date.now(),
        status: 'idle',
      });
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // `onFetched` is read at call time on purpose: a new callback must not refetch the still.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, actions, nonce]);

  return (
    <div className="wv-ctx-camera">
      {state.url ? (
        <img
          className="wv-ctx-camera__img"
          src={state.url}
          alt={`Camera snapshot ${state.capturedAt ? `captured ${formatUtcDateTime(state.capturedAt)}` : ''}`}
        />
      ) : null}
      {state.status === 'error' ? <p className="wv-ctx-muted">{state.message}</p> : null}
      <div className="wv-ctx-camera__bar">
        <span className="wv-ctx-muted">{state.status === 'loading' ? 'Fetching snapshot' : captureLabel(state)}</span>
        <Button size="sm" icon="refresh" onClick={() => setNonce((n) => n + 1)} disabled={state.status === 'loading'}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

/** Whether this window's Chromium plays HLS itself (main enables its built-in player). */
export function canPlayHlsNatively(doc: Pick<Document, 'createElement'> | undefined = globalThis.document): boolean {
  try {
    const v = doc?.createElement('video') as HTMLVideoElement | undefined;
    return Boolean(v && typeof v.canPlayType === 'function' && v.canPlayType('application/vnd.apple.mpegurl') !== '');
  } catch {
    return false;
  }
}

/** A `<video>` that says plainly when it cannot play, with a way to try again. */
function CameraVideo({ src, loop, note }: { src: string; loop?: boolean; note: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setFailed(null), [src]);
  if (failed)
    return (
      <div className="wv-ctx-camera">
        <p className="wv-ctx-muted">{failed}</p>
        <div className="wv-ctx-camera__bar">
          <span className="wv-ctx-muted">{note}</span>
          <Button
            size="sm"
            icon="refresh"
            onClick={() => {
              setFailed(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  return (
    <div className="wv-ctx-camera">
      <video
        key={attempt}
        className="wv-ctx-camera__img"
        src={attempt ? `${src}${src.includes('?') ? '&' : '?'}try=${attempt}` : src}
        autoPlay
        muted
        playsInline
        controls
        {...(loop ? { loop: true } : {})}
        onError={(e) => {
          const code = (e.currentTarget as HTMLVideoElement).error?.code;
          setFailed(
            code === 4
              ? 'The camera’s video is in a format this window cannot play.'
              : 'The camera’s video did not load — the agency’s server did not answer, or refused.',
          );
        }}
      />
      <div className="wv-ctx-camera__bar">
        <span className="wv-ctx-muted">{note}</span>
      </div>
    </div>
  );
}

/** How many connections in a row may end without a single frame before the panel says so. */
const MJPEG_RECONNECTS = 5;

/**
 * An MJPEG stream, read frame by frame (mjpeg.ts) and shown as the latest frame. When the
 * agency's server closes the stream — Taiwan's Highway Bureau does every 35 s — the last frame
 * stays and the stream is reopened at once; only a stream that keeps ending without a frame is
 * reported, after MJPEG_RECONNECTS tries.
 */
function CameraMjpeg({ url }: { url: string }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [state, setState] = useState<'connecting' | 'live' | 'reconnecting' | 'failed'>('connecting');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let current: string | null = null;
    let emptyDrops = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      void readMjpeg(
        url,
        {
          onFrame: (jpeg) => {
            emptyDrops = 0;
            if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
            const next = URL.createObjectURL(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }));
            setFrame(next);
            if (current) URL.revokeObjectURL(current);
            current = next;
            setState('live');
          },
          onDrop: (frames) => {
            if (frames === 0) emptyDrops++;
            if (emptyDrops > MJPEG_RECONNECTS) {
              setState('failed');
              return;
            }
            setState('reconnecting');
            timer = setTimeout(connect, frames > 0 ? 200 : 1000);
          },
        },
        abort.signal,
      );
    };
    setState('connecting');
    connect();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, [url, attempt]);
  const caption =
    state === 'live'
      ? 'Live video from the camera, as the agency serves it'
      : state === 'reconnecting'
        ? 'Reconnecting to the camera…'
        : state === 'connecting'
          ? 'Connecting to the camera…'
          : 'The camera’s stream keeps closing before a frame arrives.';
  return (
    <div className="wv-ctx-camera">
      {frame ? <img className="wv-ctx-camera__img" src={frame} alt="Live camera video" /> : null}
      <div className="wv-ctx-camera__bar">
        <span className="wv-ctx-muted">{caption}</span>
        {state === 'failed' ? (
          <Button size="sm" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Live view. `camera.stream` hands back a loopback relay URL with a per-camera token; the
 * camera's own address and any login stay in the main process.
 *
 *  - `mjpeg` renders as an `<img>`: continuous frames, live.
 *  - `hls` plays in a `<video>` with Chromium's own HLS player (main enables it); where the
 *    window cannot play HLS it says so rather than showing a frozen frame under "Live".
 *  - `mp4` is a recorded clip the agency replaces every few minutes (TfL's JamCams): it loops,
 *    is fetched again when the agency's next one is due, and is labelled as a clip, not live.
 *  - `snapshot-poll` — no video exists — shows the stills, labelled as stills.
 */
function CameraLiveView({
  cameraId,
  actions,
  object,
}: {
  cameraId: string;
  actions: ShellActions;
  object: WorldObject;
}) {
  const [stream, setStream] = useState<CameraStreamDescriptor | null | 'pending' | 'failed'>('pending');
  const [clipRound, setClipRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStream('pending');
    actions.cameraStream(cameraId).then(
      (s) => {
        if (!cancelled) setStream(s);
      },
      () => {
        if (!cancelled) setStream('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cameraId, actions]);

  // A recorded clip is replaced upstream every few minutes: fetch the next one when it is due.
  const refreshMs = snapshotPollMs(object);
  useEffect(() => {
    if (stream === 'pending' || stream === 'failed' || stream?.kind !== 'mp4' || !refreshMs) return undefined;
    const t = setInterval(() => setClipRound((n) => n + 1), refreshMs);
    return () => clearInterval(t);
  }, [stream, refreshMs]);

  if (stream === 'pending') return <p className="wv-ctx-muted">Starting the video…</p>;
  if (stream === 'failed' || stream === null)
    return (
      <>
        <p className="wv-ctx-muted">The video could not be started; the latest still is below.</p>
        <CameraSnapshotView cameraId={cameraId} actions={actions} {...(refreshMs ? { pollMs: refreshMs } : {})} />
      </>
    );
  switch (stream.kind) {
    case 'mjpeg':
      return <CameraMjpeg url={stream.url} />;
    case 'hls':
      return canPlayHlsNatively() ? (
        <CameraVideo src={stream.url} note="Live video from the camera, as the agency serves it" />
      ) : (
        <p className="wv-ctx-muted">
          This camera streams live HLS video, which this window cannot play (Chromium’s built-in HLS player is not
          available in this build). The Snapshot view shows its stills.
        </p>
      );
    case 'mp4': {
      const src = clipRound ? `${stream.url}?clip=${clipRound}` : stream.url;
      return (
        <CameraVideo
          src={src}
          loop
          note="A clip of a few seconds the agency records every few minutes — moving pictures, not a live stream"
        />
      );
    }
    case 'snapshot-poll':
      return <CameraSnapshotView cameraId={cameraId} actions={actions} {...(refreshMs ? { pollMs: refreshMs } : {})} />;
    default:
      return (
        <p className="wv-ctx-muted">
          This camera streams WebRTC, which this build cannot play in the window. Snapshots are available.
        </p>
      );
  }
}

/** What a camera's video is, from its catalogue: undefined when it publishes stills only. */
export function cameraVideoKind(object: WorldObject): 'hls' | 'mjpeg' | 'clip' | 'stream' | undefined {
  const kind = str(object, 'streamKind');
  if (kind === 'hls' || kind === 'mjpeg' || kind === 'clip') return kind;
  // A camera the operator registered (cameras-local) or any source that names a stream.
  if (object.media?.some((m) => m.kind === 'stream')) return 'stream';
  return undefined;
}

/** "Stills only" line for a camera with no video: how often the agency publishes a new one. */
export function stillsOnlyNote(object: WorldObject): string {
  const seconds = num(object, 'refreshSeconds');
  if (seconds === undefined || !(seconds > 0)) return 'Stills only — this camera publishes no video.';
  const every = seconds < 90 ? `${Math.round(seconds)} seconds` : `${Math.round(seconds / 60)} minutes`;
  return `Stills only — this camera publishes no video; a new picture about every ${every}, fetched as it is due.`;
}

/**
 * How often an open Snapshot view fetches the next still: the camera's own refresh interval
 * (a public catalogue says how often its images change — Hong Kong every two minutes), kept
 * between 30 s and 10 min. The view used to fetch once, so a still selected in the morning
 * was still on screen, unchanged, an hour later. A camera that states no interval refreshes
 * on the button only. Exported for tests.
 */
export function snapshotPollMs(object: WorldObject): number | undefined {
  const seconds = num(object, 'refreshSeconds');
  if (seconds === undefined || !(seconds > 0)) return undefined;
  return Math.min(600_000, Math.max(30_000, seconds * 1000));
}

const camera: ContextSection = {
  id: 'camera',
  title: 'Camera',
  render: ({ object, actions }) => <CameraSection object={object} actions={actions} />,
};

/**
 * What the Camera section says about a registered camera's picture, from its gateway's
 * health. The freshness badge above it is the registration's (the provider republishes it
 * every poll), so a camera whose host never answers still reads LIVE · High confidence; this
 * row says whether frames are actually coming (2026-10-03).
 */
/**
 * The gateway's id of a camera you added, from the panel's own camera id: the local
 * provider publishes no `cameraId` property, so the panel holds the media ref
 * `camera:<id>` while `camera.list` names the bare id.
 */
export function registeredCameraId(idOrRef: string): string {
  return /^camera:([0-9a-f]{12})$/.exec(idOrRef)?.[1] ?? idOrRef;
}

export function pictureRow(health: CameraPictureHealth | undefined, nowMs = Date.now()): string | undefined {
  if (!health) return undefined;
  const lastGood = health.lastSuccessAt ? `last good frame ${formatAgo(health.lastSuccessAt, nowMs)}` : undefined;
  const why = health.lastError?.message;
  switch (health.status) {
    case 'ok':
      return lastGood ? `Served · ${lastGood}` : 'Served';
    case 'degraded':
      return `Failing${why ? ` — ${why}` : ''}${lastGood ? ` · ${lastGood}` : ''}`;
    case 'unavailable':
      return `Unavailable${why ? ` — ${why}` : ''}${
        health.lastErrorAt ? ` · since ${formatUtcDateTime(health.lastErrorAt)}` : ''
      }${lastGood ? ` · ${lastGood}` : ''}`;
    default:
      return 'Not fetched yet';
  }
}

function CameraSection({ object, actions }: { object: WorldObject; actions: ShellActions }) {
  const video = cameraVideoKind(object);
  const [live, setLive] = useState(false);
  const cameraId = cameraIdOf(object);
  const pollMs = snapshotPollMs(object);
  // A registered camera (the gateway's): its picture health comes with the camera list,
  // read when the section opens and again after each still is asked for.
  const registered = str(object, 'gateway') !== undefined;
  const cameras = useAppState().session.cameras;
  const [fetches, setFetches] = useState(0);
  useEffect(() => {
    if (registered) void actions.listCameras();
  }, [registered, actions, cameraId, fetches]);
  const gatewayId = registeredCameraId(cameraId);
  const health = registered ? cameras?.find((c) => c.cameraId === gatewayId)?.health : undefined;
  return (
    <div className="wv-ctx-stack">
      {video ? (
        <div className="wv-ctx-actions" role="group" aria-label="Camera view">
          <Button size="sm" pressed={!live} onClick={() => setLive(false)}>
            Snapshot
          </Button>
          <Button size="sm" pressed={live} onClick={() => setLive(true)}>
            {video === 'clip' ? 'Video clip' : 'Live video'}
          </Button>
        </div>
      ) : (
        // No video exists for this camera: no "Live" to press and get a still from.
        <p className="wv-ctx-muted">{stillsOnlyNote(object)}</p>
      )}
      {live && video ? <CameraLiveView cameraId={cameraId} actions={actions} object={object} /> : null}
      {!live || !video ? (
        <CameraSnapshotView
          cameraId={cameraId}
          actions={actions}
          {...(pollMs ? { pollMs } : {})}
          {...(registered ? { onFetched: () => setFetches((n) => n + 1) } : {})}
        />
      ) : null}
      <FieldList
        rows={[
          { label: 'Picture', value: pictureRow(health) },
          { label: 'Operator', value: str(object, 'operator') },
          {
            label: 'Direction',
            value:
              str(object, 'direction') ??
              (num(object, 'headingDegrees') !== undefined ? `${num(object, 'headingDegrees')}°` : undefined),
          },
          { label: 'Gateway', value: str(object, 'gateway') },
          // A public camera's own catalogue credit (the provider's attribution covers six).
          { label: 'Attribution', value: str(object, 'attribution') },
          { label: 'Camera owner', value: str(object, 'credit') },
          { label: 'Frames retained', value: 'No — frames are shown as served and not stored' },
        ]}
      />
    </div>
  );
}

const vessel: ContextSection = {
  id: 'vessel',
  title: 'Vessel',
  render: ({ object, ownVessel, nowMs, shownAtMs }) => {
    const rows = vesselRows(object);
    const broadcast = rows.some((r) => r.label.endsWith('(as broadcast)') && r.value !== undefined);
    const approach = ownVessel ? cpa(ownVessel, object, shownAtMs ?? nowMs) : undefined;
    return (
      <div className="wv-ctx-stack">
        {approach ? (
          <FieldList
            rows={[
              {
                label: 'From your boat',
                title:
                  'Range and bearing now, and the closest point of approach if both hold their course and speed over ground. Worked out here from the two positions; not a collision warning.',
                value: (
                  <>
                    {approach.close ? <strong>Close · </strong> : null}
                    {cpaText(approach)}
                  </>
                ),
              },
            ]}
          />
        ) : null}
        <FieldList rows={rows} />
        {/* No line is drawn to the destination: the text is free-form (a port name, a code,
            "FOR ORDERS"), and no bundled port list could resolve it without guessing. */}
        {broadcast ? (
          <p className="wv-ctx-muted">
            “As broadcast”: typed into the ship’s AIS set by its crew or installer and not checked. The flag is read
            from the MMSI’s first digits (ITU maritime identification digits).
          </p>
        ) : null}
      </div>
    );
  },
};

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** "ENE (70°) at 9 mph" — NHC gives degrees and miles per hour. */
export function stormMotion(dirDeg: number | undefined, mph: number | undefined): string | undefined {
  if (dirDeg === undefined || mph === undefined) return undefined;
  if (mph === 0) return 'Stationary';
  const point = COMPASS_16[Math.round((((dirDeg % 360) + 360) % 360) / 22.5) % 16];
  return `${point} (${Math.round(dirDeg)}°) at ${mph} mph (${Math.round(mph * 1.609)} km/h)`;
}

/** "60 kt (69 mph) · Category 3" — knots as NHC gives them, with mph and the hurricane category. */
export function stormWinds(kt: number | undefined, classification: string | undefined): string | undefined {
  if (kt === undefined) return undefined;
  const cat = classification === 'HU' ? (saffirSimpson(kt) ?? 1) : undefined;
  return `${kt} kt (${Math.round(kt * 1.15078)} mph)${cat ? ` · Category ${cat}` : ''}`;
}

const storm: ContextSection = {
  id: 'storm',
  title: 'Tropical cyclone',
  render: ({ object, actions }) => {
    const advisory = safeHttpsUrl(str(object, 'advisoryUrl'));
    const graphics = safeHttpsUrl(str(object, 'graphicsUrl'));
    const issued = str(object, 'advisoryIssuedAt');
    return (
      <div className="wv-ctx-stack">
        <FieldList
          rows={[
            { label: 'Class', value: str(object, 'classificationLabel') },
            {
              label: 'Category',
              value: (() => {
                const c = cycloneOf(object);
                return c?.category ? CYCLONE_CATEGORY_NAMES[c.category] : undefined;
              })(),
            },
            { label: 'Sustained winds', value: stormWinds(num(object, 'intensityKt'), str(object, 'classification')) },
            {
              label: 'Pressure',
              value: num(object, 'pressureMb') !== undefined ? `${num(object, 'pressureMb')} mb` : undefined,
            },
            { label: 'Moving', value: stormMotion(num(object, 'movementDirDeg'), num(object, 'movementSpeedMph')) },
            { label: 'Basin', value: str(object, 'basin') },
            {
              label: 'Advisory',
              value: str(object, 'advisoryNumber')
                ? `${str(object, 'advisoryNumber')}${issued ? ` · ${formatUtcDateTime(issued)}` : ''}`
                : undefined,
            },
            { label: 'Storm id', value: str(object, 'stormId'), mono: true },
          ]}
        />
        <div className="wv-ctx-actions">
          {advisory ? (
            <Button size="sm" icon="external" onClick={() => void actions.openExternal(advisory)}>
              NHC advisory
            </Button>
          ) : null}
          {graphics ? (
            <Button size="sm" variant="ghost" icon="external" onClick={() => void actions.openExternal(graphics)}>
              Forecast cone
            </Button>
          ) : null}
        </div>
      </div>
    );
  },
};

/** "29.0 °C (84.2 °F)". */
export function formatTemperature(c: number | undefined): string | undefined {
  if (c === undefined) return undefined;
  return `${c.toFixed(1)} °C (${((c * 9) / 5 + 32).toFixed(1)} °F)`;
}

/** "5.0 m/s (11 mph) from ENE (71°)", "Calm". */
export function stationWind(mps: number | undefined, dirDeg: number | undefined): string | undefined {
  if (mps === undefined) return undefined;
  if (mps === 0) return 'Calm';
  const speed = `${mps.toFixed(1)} m/s (${Math.round(mps / 0.44704)} mph)`;
  if (dirDeg === undefined) return speed;
  const point = COMPASS_16[Math.round((((dirDeg % 360) + 360) % 360) / 22.5) % 16];
  return `${speed} from ${point} (${Math.round(dirDeg)}°)`;
}

/** "1014.8 hPa · falling 1.0 hPa in 3 h" — a change under 0.5 hPa is steady. */
export function stationPressure(hpa: number | undefined, trend3h: number | undefined): string | undefined {
  if (hpa === undefined) return undefined;
  if (trend3h === undefined) return `${hpa.toFixed(1)} hPa`;
  const way =
    Math.abs(trend3h) < 0.5 ? 'steady' : `${trend3h > 0 ? 'rising' : 'falling'} ${Math.abs(trend3h).toFixed(1)} hPa`;
  return `${hpa.toFixed(1)} hPa · ${way} in 3 h`;
}

/** "0.0 mm/h · 1.0 mm today · 5.8 mm in 24 h". */
export function stationRain(
  rate: number | undefined,
  today: number | undefined,
  day: number | undefined,
): string | undefined {
  const parts: string[] = [];
  if (rate !== undefined) parts.push(`${rate.toFixed(1)} mm/h`);
  if (today !== undefined) parts.push(`${today.toFixed(1)} mm today`);
  if (day !== undefined) parts.push(`${day.toFixed(1)} mm in 24 h`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** Heat index when it is warmer than the air, wind chill when colder; nothing when they agree. */
export function feelsLike(object: WorldObject): string | undefined {
  const t = num(object, 'temperatureC');
  if (t === undefined) return undefined;
  const hi = num(object, 'heatIndexC');
  if (hi !== undefined && hi >= t + 1) return formatTemperature(hi);
  const wc = num(object, 'windChillC');
  if (wc !== undefined && wc <= t - 1) return formatTemperature(wc);
  return undefined;
}

const weatherStation: ContextSection = {
  id: 'weather-station',
  title: 'Weather station',
  render: ({ object }) => {
    const solar = num(object, 'solarRadiationWm2');
    const uv = num(object, 'uvIndex');
    const status: string[] = [];
    if (bool(object, 'batteryLow')) status.push('transmitter battery low');
    if (str(object, 'reception') === 'scanning') status.push('not receiving the outdoor sensors');
    return (
      <FieldList
        rows={[
          { label: 'Temperature', value: formatTemperature(num(object, 'temperatureC')) },
          { label: 'Feels like', value: feelsLike(object) },
          {
            label: 'Humidity',
            value:
              num(object, 'humidityPct') !== undefined ? `${Math.round(num(object, 'humidityPct')!)} %` : undefined,
          },
          { label: 'Dew point', value: formatTemperature(num(object, 'dewPointC')) },
          { label: 'Wind', value: stationWind(num(object, 'windSpeedMps'), num(object, 'windDirDeg')) },
          {
            label: 'Gusts (10 min)',
            value:
              num(object, 'windGustMps') !== undefined ? stationWind(num(object, 'windGustMps'), undefined) : undefined,
          },
          {
            label: 'Pressure',
            value: stationPressure(num(object, 'pressureSeaLevelHpa'), num(object, 'pressureTrend3hHpa')),
          },
          {
            label: 'Rain',
            value: stationRain(num(object, 'rainRateMmH'), num(object, 'rainTodayMm'), num(object, 'rain24hMm')),
          },
          {
            label: 'Sun',
            value:
              solar !== undefined || uv !== undefined
                ? [solar !== undefined ? `${solar} W/m²` : '', uv !== undefined ? `UV ${uv}` : '']
                    .filter(Boolean)
                    .join(' · ')
                : undefined,
          },
          { label: 'Status', value: status.length ? status.join(' · ') : undefined },
          { label: 'Station id', value: str(object, 'stationId'), mono: true },
        ]}
      />
    );
  },
};

/** The U.S. EPA's AQI category for a value (the device computes the index itself). */
export function aqiCategory(aqi: number | undefined): string | undefined {
  if (aqi === undefined) return undefined;
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for sensitive groups';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

function ugm3(v: number | undefined): string | undefined {
  return v === undefined ? undefined : `${v.toFixed(1)} µg/m³`;
}

const airQuality: ContextSection = {
  id: 'sensor',
  title: 'Air quality',
  render: ({ object }) => {
    if (str(object, 'sensorKind') !== 'air-quality') return null;
    const aqi = num(object, 'aqiUs');
    const channels = str(object, 'channels');
    const a = num(object, 'pm25AUgm3');
    const b = num(object, 'pm25BUgm3');
    return (
      <FieldList
        rows={[
          { label: 'AQI (US EPA, PM2.5)', value: aqi !== undefined ? `${aqi} · ${aqiCategory(aqi)}` : undefined },
          {
            label: 'PM2.5',
            value: ugm3(num(object, 'pm25Ugm3'))
              ? `${ugm3(num(object, 'pm25Ugm3'))}${str(object, 'pmEstimate') ? ` (${str(object, 'pmEstimate')})` : ''}`
              : undefined,
          },
          {
            label: 'Laser channels',
            value:
              channels === 'disagree'
                ? `Disagree: A ${ugm3(a)}, B ${ugm3(b)} — treat the reading with caution`
                : channels === 'agree'
                  ? `Agree (A ${ugm3(a)}, B ${ugm3(b)})`
                  : channels === 'single'
                    ? 'One channel'
                    : undefined,
          },
          { label: 'PM10', value: ugm3(num(object, 'pm10Ugm3')) },
          { label: 'PM1', value: ugm3(num(object, 'pm1Ugm3')) },
          {
            label: 'Temperature',
            value: formatTemperature(num(object, 'temperatureC'))
              ? `${formatTemperature(num(object, 'temperatureC'))}, uncorrected (reads high)`
              : undefined,
          },
          {
            label: 'Humidity',
            value:
              num(object, 'humidityPct') !== undefined ? `${Math.round(num(object, 'humidityPct')!)} %` : undefined,
          },
          {
            label: 'Pressure',
            value:
              num(object, 'pressureHpa') !== undefined ? `${num(object, 'pressureHpa')!.toFixed(1)} hPa` : undefined,
          },
          {
            label: 'Placement',
            value:
              str(object, 'placement') === 'indoor'
                ? 'Indoor'
                : str(object, 'placement') === 'outdoor'
                  ? 'Outdoor'
                  : undefined,
          },
          { label: 'Sensor id', value: str(object, 'sensorId'), mono: true },
        ]}
      />
    );
  },
};

/**
 * An imagery scene (a STAC item or any capture record): what was captured, by what, when,
 * how cloudy, at what resolution, and where the source page and thumbnail are. Payload
 * keys follow docs/architecture/EVENT-RULES.md ("imagery-scene").
 */
const imageryScene: ContextSection = {
  id: 'imagery-scene',
  title: 'Satellite image',
  render: ({ object, actions }) => {
    const cloud = num(object, 'cloudCoverPct');
    const gsd = num(object, 'gsdM');
    const captured = str(object, 'capturedAt') ?? object.observedAt;
    const source = safeHttpsUrl(str(object, 'sourceUrl'));
    const thumbnail = safeHttpsUrl(str(object, 'thumbnailUrl'));
    const assets = strList(object, 'assetKeys');
    return (
      <div className="wv-ctx-stack">
        <p className="wv-ctx-summary">{sceneSummary(object, captured, cloud, gsd)}</p>
        {thumbnail ? (
          <img className="wv-ctx-camera__img" src={thumbnail} alt="Preview of the satellite image" loading="lazy" />
        ) : null}
        <FieldList
          rows={[
            { label: 'Satellite', value: str(object, 'platform') },
            { label: 'Taken', value: captured ? formatUtcDateTime(captured) : undefined },
            { label: 'Cloud cover', value: cloud !== undefined ? `${Math.round(cloud)} %` : undefined },
            { label: 'Detail', value: gsd !== undefined ? `${gsd} m per pixel` : undefined },
            { label: 'Collection', value: str(object, 'collection'), mono: true },
            { label: 'Instrument', value: str(object, 'instrument') },
            { label: 'Processing level', value: str(object, 'processingLevel') },
            { label: 'Scene id', value: str(object, 'sceneId') ?? object.id.split(':')[2], mono: true },
          ]}
        />
        {assets?.length ? (
          <details className="wv-ctx-muted">
            <summary>{assets.length} downloadable bands and files</summary>
            <p className="wv-mono">{assets.join(', ')}</p>
          </details>
        ) : null}
        {source || thumbnail ? (
          <div className="wv-ctx-actions" role="group" aria-label="Scene links">
            {source ? (
              <Button size="sm" icon="external" onClick={() => void actions.openExternal(source)}>
                Open the source page
              </Button>
            ) : null}
            {thumbnail ? (
              <Button size="sm" variant="ghost" icon="external" onClick={() => void actions.openExternal(thumbnail)}>
                Full preview
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  },
};

/**
 * What a scene is, in a sentence: the context panel only listed collection, platform and
 * asset keys, which said nothing to anyone who does not already work with STAC.
 */
export function sceneSummary(
  object: WorldObject,
  captured: string | undefined,
  cloud: number | undefined,
  gsd: number | undefined,
): string {
  const platform = str(object, 'platform');
  const by = platform
    ? ` by ${platform.replace(/^sentinel-/i, 'Sentinel-').replace(/(\d)([a-z])$/, (_m, d: string, l: string) => d + l.toUpperCase())}`
    : '';
  const when = captured ? ` on ${formatUtcDateTime(captured)}` : '';
  const facts = [
    cloud !== undefined ? `${Math.round(cloud)} % cloud` : undefined,
    gsd !== undefined ? `${gsd} m per pixel` : undefined,
  ].filter(Boolean);
  return (
    `A photo of this area taken from orbit${by}${when}${facts.length ? ` (${facts.join(', ')})` : ''}. ` +
    'The square it draws when selected is the ground the image covers; the image itself is on the source page.'
  );
}

export const TYPE_SECTIONS: ReadonlyArray<{ type: string; sections: ContextSection[] }> = [
  { type: 'aircraft', sections: [aircraft] },
  { type: 'earthquake', sections: [earthquake] },
  { type: 'satellite', sections: [satellite] },
  { type: 'fire-detection', sections: [fireDetection] },
  { type: 'weather-alert', sections: [weatherAlert] },
  { type: 'storm', sections: [storm] },
  { type: 'weather-station', sections: [weatherStation] },
  { type: 'sensor', sections: [airQuality] },
  { type: 'imagery-scene', sections: [imageryScene] },
  { type: 'camera', sections: [camera] },
  { type: 'vessel', sections: [vessel] },
];

for (const { type, sections } of TYPE_SECTIONS) contextRegistry.register(type, sections);
