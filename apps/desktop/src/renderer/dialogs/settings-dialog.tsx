import { Button, Dialog, FieldList, Section, StatusBadge, Toggle, formatAgo } from '@worldview/ui';
import { BASEMAP_CATALOG, TERRAIN_CATALOG } from '../basemaps.js';
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
  const basemaps = BASEMAP_CATALOG.some((b) => b.id === s.basemapId) ? BASEMAP_CATALOG : [{ id: s.basemapId, name: `${s.basemapId} (configured by runtime)`, attribution: '', mode: 'both' as const, offline: false }, ...BASEMAP_CATALOG];
  const terrains = TERRAIN_CATALOG.some((t) => t.id === s.terrainId) ? TERRAIN_CATALOG : [{ id: s.terrainId, name: `${s.terrainId} (configured by runtime)`, attribution: '' }, ...TERRAIN_CATALOG];
  return (
    <Dialog open title="Settings" onClose={() => actions.closeDialog()} size="lg" description="Preferences are stored locally by the runtime. Nothing here is sent anywhere.">
      <div className="wv-settings">
        <Section title="Rendering">
          <div className="wv-ctx-actions" role="radiogroup" aria-label="Render mode">
            {(['2D', '3D', 'AUTO'] as const).filter((m) => m === '2D' || supports3D).map((m) => (
              <Button key={m} size="sm" pressed={ui.mode === m} onClick={() => void actions.setMode(m)}>{m === 'AUTO' ? 'Automatic' : m}</Button>
            ))}
          </div>
          <label className="wv-field">Basemap
            <select className="wv-select" value={s.basemapId} onChange={(e) => void actions.updateSettings({ basemapId: e.target.value })}>
              {basemaps.map((b) => <option key={b.id} value={b.id}>{b.name}{b.offline ? '' : ' (online)'}</option>)}
            </select>
          </label>
          <label className="wv-field">Terrain
            <select className="wv-select" value={s.terrainId} onChange={(e) => void actions.updateSettings({ terrainId: e.target.value })}>
              {terrains.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        </Section>
        <Section title="Display">
          <label className="wv-field">Text scale
            <select className="wv-select" value={String(s.textScale)} onChange={(e) => void actions.updateSettings({ textScale: Number(e.target.value) })}>
              {(TEXT_SCALES.includes(s.textScale) ? TEXT_SCALES : [s.textScale, ...TEXT_SCALES]).map((v) => <option key={v} value={String(v)}>{Math.round(v * 100)}%</option>)}
            </select>
          </label>
          <Toggle label="Reduced motion" description="Disables map fly animations and transitions (also follows the OS setting)." checked={s.reducedMotion} onChange={(v) => void actions.updateSettings({ reducedMotion: v })} />
        </Section>
        <Section title="Updates">
          <Toggle label="Check for updates automatically" checked={s.updater.automatic} onChange={(v) => void actions.updateSettings({ updater: { ...s.updater, automatic: v } })} />
          <Toggle label="Include pre-release builds" checked={s.updater.prerelease} onChange={(v) => void actions.updateSettings({ updater: { ...s.updater, prerelease: v } })} />
          {updater.state ? (
            <FieldList rows={[
              { label: 'Status', value: updater.state.status },
              { label: 'Installed', value: updater.state.currentVersion, mono: true },
              { label: 'Available', value: updater.state.availableVersion, mono: true },
              { label: 'Signature', value: updater.state.signed ? 'verified' : 'unsigned build — install is check-only' },
              { label: 'Last checked', value: updater.state.lastCheckedAt ? formatAgo(updater.state.lastCheckedAt, nowMs) : undefined },
              { label: 'Note', value: updater.state.message },
            ]} />
          ) : null}
          <div className="wv-ctx-actions">
            {updater.state?.status !== 'disabled' ? <Button size="sm" icon="refresh" onClick={() => void actions.checkForUpdates()}>Check now</Button> : null}
            {updater.state?.status === 'downloaded' && updater.state.signed ? <Button size="sm" variant="primary" onClick={() => void actions.installUpdate()}>Install and restart</Button> : null}
          </div>
        </Section>
        <Section title="Providers">
          <ul className="wv-settings__providers">
            {sources.entries.map((e) => (
              <li key={e.providerId} className="wv-settings__provider">
                <Toggle size="sm" label={e.name} description={`${e.categories.join(', ')} · ${e.locality}`} checked={e.enabled} onChange={(v) => void actions.setSourceEnabled(e.providerId, v)} />
                <StatusBadge kind="provider" value={e.health.status} size="sm" />
                {e.meta.credentialsRequired.length ? <Button size="sm" variant="ghost" icon="key" onClick={() => { actions.closeDialog(); actions.openSource(e.providerId); }}>Credentials</Button> : null}
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Offline packs">
          {offline.status?.packs.length ? (
            <ul className="wv-settings__packs">
              {offline.status.packs.map((p) => (
                <li key={p.id} className="wv-settings__pack">
                  <Toggle size="sm" label={`${p.name} ${p.version}`} description={`${p.contents.join(', ')} · ${p.status}${p.message ? ` — ${p.message}` : ''}`} checked={p.status === 'active'} onChange={(v) => void actions.setPackEnabled(p.id, v)} />
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => void actions.removePack(p.id)}>Remove</Button>
                </li>
              ))}
            </ul>
          ) : <p className="wv-ctx-muted">No offline packs installed.</p>}
          <Button size="sm" icon="upload" onClick={() => void actions.installOfflinePack()}>Install offline pack</Button>
        </Section>
        <Section title="Privacy">
          <FieldList rows={[{ label: 'Telemetry', value: 'Off — WORLDVIEW sends no usage data' }, { label: 'Credentials', value: 'Stored in the operating system secure store; never shown in the UI or logs' }]} />
        </Section>
      </div>
    </Dialog>
  );
}
