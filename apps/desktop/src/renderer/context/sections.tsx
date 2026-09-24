import { useEffect, useState } from 'react';
import type { WorldObject } from '@worldview/world-model';
import type { CameraStreamDescriptor } from '@worldview/ipc-contract';
import {
  Button,
  FieldList,
  StatusBadge,
  formatAgo,
  formatAltitude,
  formatDepthKm,
  formatDuration,
  formatMagnitude,
  formatRelativeAge,
  formatUtcDateTime,
} from '@worldview/ui';
import { contextRegistry, type ContextSection } from './registry.js';
import { bool, num, safeHttpsUrl, str, strList, yesNo } from './props.js';
import type { ShellActions } from '../store/actions.js';
import { readMjpeg } from './mjpeg.js';

/**
 * Type-specific context sections (directive §62). Property names follow the provider
 * normalizers' payload conventions (e.g. providers/usgs/src/normalize.ts). Sections
 * return null when the object carries none of their fields, so no empty headings render.
 */
const aircraft: ContextSection = {
  id: 'aircraft',
  title: 'Aircraft',
  render: ({ object }) => (
    <FieldList
      rows={[
        { label: 'Callsign', value: object.labels['callsign'] ?? str(object, 'callsign'), mono: true },
        { label: 'Registration', value: object.labels['registration'] ?? str(object, 'registration'), mono: true },
        { label: 'ICAO 24', value: str(object, 'icao24') ?? object.id.split(':')[2], mono: true },
        { label: 'Aircraft type', value: str(object, 'aircraftType') ?? str(object, 'typeCode') },
        { label: 'Squawk', value: str(object, 'squawk'), mono: true },
        { label: 'On ground', value: yesNo(bool(object, 'onGround')) },
        { label: 'Category', value: str(object, 'category') },
        { label: 'Origin country', value: str(object, 'originCountry') },
        { label: 'Barometric altitude', value: formatAltitude(num(object, 'baroAltitudeM'), 'ft') },
      ]}
    />
  ),
};

const earthquake: ContextSection = {
  id: 'earthquake',
  title: 'Earthquake',
  render: ({ object, actions }) => {
    const detail = safeHttpsUrl(str(object, 'detailUrl'));
    const tsunami = bool(object, 'tsunami');
    return (
      <div className="wv-ctx-stack">
        <FieldList
          rows={[
            { label: 'Magnitude', value: formatMagnitude(num(object, 'magnitude'), str(object, 'magType')) },
            { label: 'Depth', value: formatDepthKm(num(object, 'depthKm')) },
            { label: 'Place', value: str(object, 'place') },
            {
              label: 'Tsunami',
              value: tsunami === undefined ? undefined : tsunami ? 'Tsunami flag set' : 'No tsunami flag',
            },
            { label: 'Alert level', value: str(object, 'alert') },
            { label: 'Status', value: str(object, 'status') },
            { label: 'Event type', value: str(object, 'eventType') },
            { label: 'Felt reports', value: num(object, 'felt')?.toLocaleString('en-US') },
            { label: 'Significance', value: num(object, 'significance')?.toLocaleString('en-US') },
            {
              label: 'Stations',
              value: num(object, 'stations') !== undefined ? String(num(object, 'stations')) : undefined,
            },
            { label: 'Network', value: str(object, 'network'), mono: true },
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
  render: ({ object }) => {
    const period = num(object, 'periodMinutes');
    const epoch = str(object, 'epoch');
    // CelesTrak's element sets say `inclination`; the recorded demo world says `inclinationDeg`.
    const inclination = num(object, 'inclination') ?? num(object, 'inclinationDeg');
    const apogee = num(object, 'apogeeKm');
    const perigee = num(object, 'perigeeKm');
    return (
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
          { label: 'Group', value: str(object, 'group') },
        ]}
      />
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

const weatherAlert: ContextSection = {
  id: 'weather-alert',
  title: 'Alert',
  render: ({ object, nowMs }) => {
    const expires = str(object, 'expires');
    const severity = str(object, 'severity');
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
            { label: 'Urgency', value: str(object, 'urgency') },
            { label: 'Certainty', value: str(object, 'certainty') },
            { label: 'Sender', value: str(object, 'senderName') },
            {
              label: 'Effective',
              value: str(object, 'effective') ? formatUtcDateTime(str(object, 'effective')) : undefined,
            },
            {
              label: 'Expires',
              value: expires
                ? `${formatUtcDateTime(expires)} (${Date.parse(expires) > nowMs ? 'in ' + formatDuration(Date.parse(expires) - nowMs) : 'expired ' + formatAgo(expires, nowMs)})`
                : undefined,
            },
          ]}
        />
        {str(object, 'instruction') ? <p className="wv-ctx-instruction">{str(object, 'instruction')}</p> : null}
        {str(object, 'description') ? <p className="wv-ctx-description">{str(object, 'description')}</p> : null}
      </div>
    );
  },
};

function cameraIdOf(object: WorldObject): string {
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
}: {
  cameraId: string;
  actions: ShellActions;
  pollMs?: number;
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
      if (!snap) {
        setState({ url: null, capturedAt: null, status: 'error', message: 'No snapshot returned' });
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

function CameraSection({ object, actions }: { object: WorldObject; actions: ShellActions }) {
  const video = cameraVideoKind(object);
  const [live, setLive] = useState(false);
  const cameraId = cameraIdOf(object);
  const pollMs = snapshotPollMs(object);
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
        <CameraSnapshotView cameraId={cameraId} actions={actions} {...(pollMs ? { pollMs } : {})} />
      ) : null}
      <FieldList
        rows={[
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
  render: ({ object }) => (
    <FieldList
      rows={[
        { label: 'MMSI', value: str(object, 'mmsi') ?? object.id.split(':')[2], mono: true },
        { label: 'Name', value: object.labels['name'] ?? str(object, 'name') },
        {
          label: 'IMO',
          value: str(object, 'imo') ?? (num(object, 'imo') !== undefined ? String(num(object, 'imo')) : undefined),
          mono: true,
        },
        { label: 'Call sign', value: str(object, 'callSign'), mono: true },
        { label: 'Ship type', value: str(object, 'shipType') },
        { label: 'Navigation status', value: str(object, 'navStatus') },
        { label: 'Destination', value: str(object, 'destination') },
        { label: 'ETA', value: str(object, 'eta') ? formatUtcDateTime(str(object, 'eta')) : undefined },
        {
          label: 'Draught',
          value: num(object, 'draughtM') !== undefined ? `${num(object, 'draughtM')!.toFixed(1)} m` : undefined,
        },
        {
          label: 'Length × beam',
          value:
            num(object, 'lengthM') !== undefined && num(object, 'beamM') !== undefined
              ? `${num(object, 'lengthM')} m × ${num(object, 'beamM')} m`
              : undefined,
        },
      ]}
    />
  ),
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
  const cat = classification === 'HU' ? (kt >= 137 ? 5 : kt >= 113 ? 4 : kt >= 96 ? 3 : kt >= 83 ? 2 : 1) : undefined;
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

export const TYPE_SECTIONS: ReadonlyArray<{ type: string; sections: ContextSection[] }> = [
  { type: 'aircraft', sections: [aircraft] },
  { type: 'earthquake', sections: [earthquake] },
  { type: 'satellite', sections: [satellite] },
  { type: 'fire-detection', sections: [fireDetection] },
  { type: 'weather-alert', sections: [weatherAlert] },
  { type: 'storm', sections: [storm] },
  { type: 'weather-station', sections: [weatherStation] },
  { type: 'sensor', sections: [airQuality] },
  { type: 'camera', sections: [camera] },
  { type: 'vessel', sections: [vessel] },
];

for (const { type, sections } of TYPE_SECTIONS) contextRegistry.register(type, sections);
