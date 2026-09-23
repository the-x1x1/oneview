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

/**
 * Live view. `camera.stream` hands back a loopback relay URL with a per-camera token;
 * the camera's own address and login stay in the main process.
 *
 * MJPEG and a polled still both render as an `<img>`. HLS and WebRTC do not: Chromium
 * plays neither natively, and no player library is bundled, so those say so plainly and
 * the snapshot view stays — showing a frozen frame under a "Live" label would be a lie.
 */
function CameraLiveView({ cameraId, actions }: { cameraId: string; actions: ShellActions }) {
  const [stream, setStream] = useState<CameraStreamDescriptor | null | 'pending'>('pending');

  useEffect(() => {
    let cancelled = false;
    setStream('pending');
    void actions.cameraStream(cameraId).then((s) => {
      if (!cancelled) setStream(s);
    });
    return () => {
      cancelled = true;
    };
  }, [cameraId, actions]);

  if (stream === 'pending') return <p className="wv-ctx-muted">Starting the stream…</p>;
  if (stream === null)
    return <p className="wv-ctx-muted">This camera has no live stream; the snapshot below is what it served.</p>;
  if (stream.kind === 'mjpeg') {
    return <img className="wv-ctx-camera__img" src={stream.url} alt="Live camera stream" />;
  }
  if (stream.kind === 'snapshot-poll') {
    return <CameraSnapshotView cameraId={cameraId} actions={actions} pollMs={5000} />;
  }
  return (
    <p className="wv-ctx-muted">
      This camera streams {stream.kind === 'hls' ? 'HLS' : 'WebRTC'}, which this build cannot play in the window (no
      player is bundled). Snapshots below are live; the stream URL works in a player such as VLC.
    </p>
  );
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
  const [live, setLive] = useState(false);
  const cameraId = cameraIdOf(object);
  return (
    <div className="wv-ctx-stack">
      <div className="wv-ctx-actions" role="group" aria-label="Camera view">
        <Button size="sm" pressed={!live} onClick={() => setLive(false)}>
          Snapshot
        </Button>
        <Button size="sm" pressed={live} onClick={() => setLive(true)}>
          Live
        </Button>
      </div>
      {live ? <CameraLiveView cameraId={cameraId} actions={actions} /> : null}
      {!live ? (
        <CameraSnapshotView
          cameraId={cameraId}
          actions={actions}
          {...(snapshotPollMs(object) ? { pollMs: snapshotPollMs(object)! } : {})}
        />
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

export const TYPE_SECTIONS: ReadonlyArray<{ type: string; sections: ContextSection[] }> = [
  { type: 'aircraft', sections: [aircraft] },
  { type: 'earthquake', sections: [earthquake] },
  { type: 'satellite', sections: [satellite] },
  { type: 'fire-detection', sections: [fireDetection] },
  { type: 'weather-alert', sections: [weatherAlert] },
  { type: 'camera', sections: [camera] },
  { type: 'vessel', sections: [vessel] },
];

for (const { type, sections } of TYPE_SECTIONS) contextRegistry.register(type, sections);
