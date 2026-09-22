import { useEffect, useState, type FormEvent } from 'react';
import { Button, Dialog, FieldList, Section, StatusBadge, Toggle, formatAgo } from '@worldview/ui';
import { basemapChoices, terrainChoices } from '../map-providers.js';
import { useActions, useAppState } from '../store/store.js';
import { useNow } from '../hooks/use-now.js';

const TEXT_SCALES = [0.9, 1, 1.15, 1.3, 1.5];

/** Settings: render mode, basemap/terrain, updater, text scale, reduced motion, providers, offline packs. */
export function SettingsDialog() {
  const { ui, session, sources, updater, offline } = useAppState();
  const actions = useActions();
  const nowMs = useNow(5000);
  const s = session.settings;
  if (ui.dialog !== 'settings' || !s) return null;
  const supports3D = ui.supports3D;
  const basemaps = basemapChoices(session.mapProviders, s.basemapId);
  const terrains = terrainChoices(session.mapProviders, s.terrainId);
  return (
    <Dialog
      open
      title="Settings"
      onClose={() => actions.closeDialog()}
      size="lg"
      description="Preferences are stored locally by the runtime. Nothing here is sent anywhere."
    >
      <div className="wv-settings">
        <Section title="Rendering">
          <div className="wv-ctx-actions" role="radiogroup" aria-label="Render mode">
            {(['2D', '3D', 'AUTO'] as const)
              .filter((m) => m === '2D' || supports3D)
              .map((m) => (
                <Button key={m} size="sm" pressed={ui.mode === m} onClick={() => void actions.setMode(m)}>
                  {m === 'AUTO' ? 'Automatic' : m}
                </Button>
              ))}
          </div>
          <label className="wv-field">
            Basemap
            <select
              className="wv-select"
              value={s.basemapId}
              onChange={(e) => void actions.updateSettings({ basemapId: e.target.value })}
            >
              {basemaps.map((b) => (
                <option key={b.id} value={b.id} disabled={!b.available} title={b.unavailableReason}>
                  {b.name}
                  {b.offlineCapable ? '' : ' (online)'}
                  {b.available ? '' : ' — unavailable'}
                </option>
              ))}
            </select>
          </label>
          <label className="wv-field">
            Terrain
            <select
              className="wv-select"
              value={s.terrainId}
              onChange={(e) => void actions.updateSettings({ terrainId: e.target.value })}
            >
              {terrains.map((t) => (
                <option key={t.id} value={t.id} disabled={!t.available} title={t.unavailableReason}>
                  {t.name}
                  {t.available ? '' : ' — unavailable'}
                </option>
              ))}
            </select>
          </label>
        </Section>
        <Section title="Display">
          <label className="wv-field">
            Text scale
            <select
              className="wv-select"
              value={String(s.textScale)}
              onChange={(e) => void actions.updateSettings({ textScale: Number(e.target.value) })}
            >
              {(TEXT_SCALES.includes(s.textScale) ? TEXT_SCALES : [s.textScale, ...TEXT_SCALES]).map((v) => (
                <option key={v} value={String(v)}>
                  {Math.round(v * 100)}%
                </option>
              ))}
            </select>
          </label>
          <Toggle
            label="Reduced motion"
            description="Disables map fly animations and transitions (also follows the OS setting)."
            checked={s.reducedMotion}
            onChange={(v) => void actions.updateSettings({ reducedMotion: v })}
          />
        </Section>
        <Section title="Updates">
          <Toggle
            label="Check for updates automatically"
            checked={s.updater.automatic}
            onChange={(v) => void actions.updateSettings({ updater: { ...s.updater, automatic: v } })}
          />
          <Toggle
            label="Include pre-release builds"
            checked={s.updater.prerelease}
            onChange={(v) => void actions.updateSettings({ updater: { ...s.updater, prerelease: v } })}
          />
          {updater.state ? (
            <FieldList
              rows={[
                { label: 'Status', value: updater.state.status },
                { label: 'Installed', value: updater.state.currentVersion, mono: true },
                { label: 'Available', value: updater.state.availableVersion, mono: true },
                {
                  label: 'Signature',
                  value: updater.state.signed ? 'verified' : 'unsigned build — install is check-only',
                },
                {
                  label: 'Last checked',
                  value: updater.state.lastCheckedAt ? formatAgo(updater.state.lastCheckedAt, nowMs) : undefined,
                },
                { label: 'Note', value: updater.state.message },
              ]}
            />
          ) : null}
          <div className="wv-ctx-actions">
            {updater.state?.status !== 'disabled' ? (
              <Button size="sm" icon="refresh" onClick={() => void actions.checkForUpdates()}>
                Check now
              </Button>
            ) : null}
            {updater.state?.status === 'downloaded' && updater.state.signed ? (
              <Button size="sm" variant="primary" onClick={() => void actions.installUpdate()}>
                Install and restart
              </Button>
            ) : null}
          </div>
        </Section>
        <Section title="Providers">
          <ul className="wv-settings__providers">
            {sources.entries.map((e) => (
              <li key={e.providerId} className="wv-settings__provider">
                <Toggle
                  size="sm"
                  label={e.name}
                  description={`${e.categories.join(', ')} · ${e.locality}`}
                  checked={e.enabled}
                  onChange={(v) => void actions.setSourceEnabled(e.providerId, v)}
                />
                <StatusBadge kind="provider" value={e.health.status} size="sm" />
                {e.meta.credentialsRequired.length ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="key"
                    onClick={() => {
                      actions.closeDialog();
                      actions.openSource(e.providerId);
                    }}
                  >
                    Credentials
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Offline packs">
          {offline.status?.packs.length ? (
            <ul className="wv-settings__packs">
              {offline.status.packs.map((p) => (
                <li key={p.id} className="wv-settings__pack">
                  <Toggle
                    size="sm"
                    label={`${p.name} ${p.version}`}
                    description={`${p.contents.join(', ')} · ${p.status}${p.message ? ` — ${p.message}` : ''}`}
                    checked={p.status === 'active'}
                    onChange={(v) => void actions.setPackEnabled(p.id, v)}
                  />
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => void actions.removePack(p.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wv-ctx-muted">No offline packs installed.</p>
          )}
          <Button size="sm" icon="upload" onClick={() => void actions.installOfflinePack()}>
            Install offline pack
          </Button>
        </Section>
        <Section title="Cameras">
          <CameraList />
          <AddCameraForm />
          <Go2rtcField path={s.cameras.go2rtcPath} />
        </Section>
        <Section title="Privacy">
          <FieldList
            rows={[
              { label: 'Telemetry', value: 'Off — WORLDVIEW sends no usage data' },
              {
                label: 'Credentials',
                value: 'Stored in the operating system secure store; never shown in the UI or logs',
              },
            ]}
          />
        </Section>
      </div>
    </Dialog>
  );
}

/**
 * RTSP support is an optional binary the operator installs and verifies themselves
 * (docs/operator/cameras.md). WORLDVIEW never downloads it, never searches for it and
 * never runs anything until this names a file that exists; the runtime rejects a
 * relative path, and the rejection surfaces as an ordinary "settings not saved" notice.
 */
function Go2rtcField({ path }: { path: string }) {
  const actions = useActions();
  const [value, setValue] = useState(path);
  const [busy, setBusy] = useState(false);
  const dirty = value.trim() !== path;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    const saved = await actions.updateSettings({ cameras: { go2rtcPath: value.trim() } });
    setBusy(false);
    if (saved) setValue(saved.cameras.go2rtcPath);
  };
  return (
    <form className="wv-credential" onSubmit={(e) => void submit(e)}>
      <label className="wv-credential__label" htmlFor="go2rtc-path">
        go2rtc binary <span className="wv-ctx-muted">optional — only RTSP cameras need it</span>
      </label>
      <div className="wv-credential__row">
        <input
          id="go2rtc-path"
          className="wv-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Absolute path, e.g. C:\Tools\go2rtc\go2rtc.exe"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
        />
        <Button size="sm" type="submit" variant="primary" disabled={busy || !dirty}>
          Save
        </Button>
        {path ? (
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            disabled={busy}
            onClick={() => {
              setValue('');
              void actions.updateSettings({ cameras: { go2rtcPath: '' } });
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
      <span className="wv-credential__state">
        {path
          ? 'Configured — Help → Diagnostics shows whether it started'
          : 'Not configured — RTSP cameras are refused; MJPEG, HLS and snapshot URLs work without it'}
      </span>
    </form>
  );
}

/** Cameras the gateway has registered. The interface is never told a camera's URL. */
function CameraList() {
  const { session } = useAppState();
  const actions = useActions();
  const cameras = session.cameras;

  useEffect(() => {
    if (cameras === null) void actions.listCameras();
  }, [cameras, actions]);

  if (cameras === null) return <p className="wv-ctx-muted">Loading cameras…</p>;
  if (cameras.length === 0)
    return (
      <p className="wv-ctx-muted">
        No cameras added. Public camera catalogs are separate — enable them under Providers.
      </p>
    );
  return (
    <ul className="wv-settings__packs" aria-label="Registered cameras">
      {cameras.map((c) => (
        <li key={c.cameraId} className="wv-settings__pack">
          <div>
            <strong>{c.name}</strong>
            <span className="wv-ctx-muted"> · {c.gateway === 'go2rtc' ? 'RTSP via go2rtc' : 'fetched directly'}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            onClick={() => void actions.unregisterCamera(c.cameraId, c.name)}
          >
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Add a camera by URL. A login in the URL (`http://user:pass@host/…`) is accepted here
 * and removed by the main process before anything is stored: it goes to the OS
 * credential store and is re-attached only when that camera is fetched. The value is
 * cleared from this component as soon as it is submitted, so it is never held in
 * interface state longer than the request.
 */
function AddCameraForm() {
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [heading, setHeading] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName('');
    setUrl('');
    setLatitude('');
    setLongitude('');
    setHeading('');
  };
  const coords = (): { latitude: number; longitude: number } | undefined => {
    const lat = Number(latitude),
      lon = Number(longitude);
    if (!latitude.trim() || !longitude.trim()) return undefined;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
    return { latitude: lat, longitude: lon };
  };
  const positionInvalid = (latitude.trim() !== '' || longitude.trim() !== '') && coords() === undefined;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim() || !url.trim() || positionInvalid) return;
    setBusy(true);
    const position = coords();
    const headingValue = Number(heading);
    const registered = await actions.registerCamera({
      name: name.trim(),
      url: url.trim(),
      ...(position ? { position } : {}),
      ...(heading.trim() && Number.isFinite(headingValue) ? { headingDegrees: headingValue } : {}),
    });
    setBusy(false);
    if (registered) {
      reset();
      setOpen(false);
    }
  };

  if (!open)
    return (
      <Button size="sm" icon="plus" onClick={() => setOpen(true)}>
        Add camera
      </Button>
    );
  return (
    <form className="wv-camera-form" onSubmit={(e) => void submit(e)}>
      <label className="wv-field">
        Name
        <input
          className="wv-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          maxLength={120}
          required
        />
      </label>
      <label className="wv-field">
        URL
        <input
          className="wv-input"
          type="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          placeholder="http://192.168.1.10/snapshot.jpg — MJPEG, HLS or still image; rtsp:// needs go2rtc"
          required
        />
      </label>
      <div className="wv-camera-form__row">
        <label className="wv-field">
          Latitude
          <input
            className="wv-input"
            inputMode="decimal"
            value={latitude}
            onChange={(e) => setLatitude(e.target.value)}
            disabled={busy}
            placeholder="optional"
          />
        </label>
        <label className="wv-field">
          Longitude
          <input
            className="wv-input"
            inputMode="decimal"
            value={longitude}
            onChange={(e) => setLongitude(e.target.value)}
            disabled={busy}
            placeholder="optional"
          />
        </label>
        <label className="wv-field">
          Facing
          <input
            className="wv-input"
            inputMode="decimal"
            value={heading}
            onChange={(e) => setHeading(e.target.value)}
            disabled={busy}
            placeholder="° from north"
          />
        </label>
      </div>
      {positionInvalid ? (
        <p className="wv-ctx-muted" role="alert">
          Give both latitude and longitude, within ±90 and ±180 — or leave both empty.
        </p>
      ) : null}
      <p className="wv-ctx-muted">
        A login in the URL is moved to the operating system credential store on save and never shown again. WORLDVIEW
        contacts only this address; it never scans your network.
      </p>
      <div className="wv-ctx-actions">
        <Button
          size="sm"
          type="submit"
          variant="primary"
          disabled={busy || !name.trim() || !url.trim() || positionInvalid}
        >
          Add camera
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
