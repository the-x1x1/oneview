import { useEffect, useState } from 'react';
import type { DiagnosticsSnapshot } from '@worldview/ipc-contract';
import {
  Button,
  Dialog,
  ErrorState,
  FieldList,
  LoadingState,
  Section,
  StatusBadge,
  formatBytes,
  formatUtcDateTime,
} from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';

/** Help → Diagnostics (directive §83): every field of DiagnosticsSnapshot plus a redacted export. */
export function DiagnosticsDialog() {
  const { ui } = useAppState();
  const actions = useActions();
  const open = ui.dialog === 'diagnostics';
  const [snap, setSnap] = useState<DiagnosticsSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSnap(null);
    setFailed(false);
    void actions.getDiagnostics().then((s) => {
      if (!cancelled) {
        setSnap(s);
        setFailed(!s);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, actions, nonce]);

  if (!open) return null;
  return (
    <Dialog
      open
      title="Diagnostics"
      onClose={() => actions.closeDialog()}
      size="lg"
      description="Runtime state for support requests. The export is redacted: no credentials, no personal paths beyond the data directory."
      footer={
        <>
          <Button icon="refresh" onClick={() => setNonce((n) => n + 1)}>
            Refresh
          </Button>
          <Button variant="primary" icon="download" onClick={() => void actions.exportDiagnostics()} disabled={!snap}>
            Export diagnostics
          </Button>
        </>
      }
    >
      {failed ? (
        <ErrorState
          title="Diagnostics unavailable"
          message="The runtime did not return a snapshot."
          retry={{ onClick: () => setNonce((n) => n + 1) }}
        />
      ) : null}
      {!snap && !failed ? <LoadingState label="Collecting diagnostics" /> : null}
      {snap ? <DiagnosticsBody snap={snap} /> : null}
    </Dialog>
  );
}

function DiagnosticsBody({ snap }: { snap: DiagnosticsSnapshot }) {
  return (
    <div className="wv-diagnostics">
      <Section title="Application">
        <FieldList
          rows={[
            { label: 'Version', value: snap.app.version, mono: true },
            { label: 'Channel', value: snap.app.channel },
            { label: 'Commit', value: snap.app.commit, mono: true },
            { label: 'Demo mode', value: snap.app.demoMode ? 'yes — recorded data' : 'no' },
            { label: 'Started', value: formatUtcDateTime(snap.app.startedAt) },
          ]}
        />
      </Section>
      <Section title="Runtime">
        <FieldList
          rows={[
            { label: 'Electron', value: snap.runtime.electron },
            { label: 'Chrome', value: snap.runtime.chrome },
            { label: 'Node', value: snap.runtime.node },
            { label: 'Platform', value: `${snap.runtime.platform} ${snap.runtime.arch}` },
          ]}
        />
      </Section>
      <Section title="Renderer">
        <FieldList
          rows={[
            { label: 'Active', value: snap.renderer.active },
            { label: 'WebGL2', value: snap.renderer.webgl2 ? 'available' : 'not available' },
            { label: 'GPU', value: snap.renderer.gpu },
            { label: 'FPS', value: snap.renderer.fps !== undefined ? String(snap.renderer.fps) : undefined },
          ]}
        />
      </Section>
      <Section title="Database">
        <FieldList
          rows={[
            { label: 'Status', value: snap.database.status },
            { label: 'Backend', value: snap.database.backend },
            { label: 'Size', value: formatBytes(snap.database.sizeBytes) },
            { label: 'Partitions', value: String(snap.database.partitions) },
            { label: 'Note', value: snap.database.message },
          ]}
        />
      </Section>
      <Section title="Providers">
        <table className="wv-sources" aria-label="Provider health">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">State</th>
              <th scope="col">Objects</th>
              <th scope="col">Errors</th>
            </tr>
          </thead>
          <tbody>
            {snap.providers.map((p) => (
              <tr key={p.providerId}>
                <td>{p.name}</td>
                <td>
                  <StatusBadge kind="provider" value={p.health.status} size="sm" />
                </td>
                <td className="wv-num">{p.health.objectCount ?? 0}</td>
                <td className="wv-num">
                  {Math.round(p.health.errorRate * 100)}%{p.health.lastError ? ` · ${p.health.lastError.code}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Offline">
        <FieldList
          rows={[
            {
              label: 'Connection',
              value: `${snap.offline.connection.state} · ${snap.offline.connection.remoteLive}/${snap.offline.connection.remoteTotal} remote · ${snap.offline.connection.localLive} local · network ${snap.offline.connection.networkOnline ? 'up' : 'down'}`,
            },
            {
              label: 'Packs',
              value: snap.offline.packs.length
                ? snap.offline.packs
                    .map((p) => `${p.name} ${p.version} (${p.status}, ${formatBytes(p.sizeBytes)})`)
                    .join('; ')
                : 'none installed',
            },
            {
              label: 'Capabilities',
              value: Object.entries(snap.offline.capabilities)
                .map(([k, v]) => `${k}: ${v ? 'yes' : 'no'}`)
                .join(' · '),
            },
          ]}
        />
      </Section>
      <Section title="Sidecars">
        {snap.sidecars.length ? (
          <FieldList
            rows={snap.sidecars.map((s) => ({
              label: s.id,
              value: `${s.status}${s.version ? ` ${s.version}` : ''}${s.message ? ` — ${s.message}` : ''}`,
            }))}
          />
        ) : (
          <p className="wv-ctx-muted">No sidecars configured.</p>
        )}
      </Section>
      <Section title="Updater">
        <FieldList
          rows={[
            { label: 'Channel', value: snap.updater.channel },
            { label: 'Automatic', value: snap.updater.automatic ? 'yes' : 'no' },
            { label: 'Status', value: snap.updater.status },
            { label: 'Current', value: snap.updater.currentVersion, mono: true },
            { label: 'Available', value: snap.updater.availableVersion, mono: true },
            { label: 'Signed', value: snap.updater.signed ? 'yes' : 'no' },
            {
              label: 'Last checked',
              value: snap.updater.lastCheckedAt ? formatUtcDateTime(snap.updater.lastCheckedAt) : undefined,
            },
            { label: 'Message', value: snap.updater.message },
          ]}
        />
      </Section>
      <Section title="Disk & logs">
        <FieldList
          rows={[
            { label: 'Data directory', value: snap.disk.dataDir, mono: true },
            { label: 'Used', value: formatBytes(snap.disk.usedBytes) },
            { label: 'Free', value: snap.disk.freeBytes !== undefined ? formatBytes(snap.disk.freeBytes) : undefined },
            { label: 'Log file', value: snap.logs.path, mono: true },
            { label: 'Log size', value: formatBytes(snap.logs.sizeBytes) },
          ]}
        />
      </Section>
    </div>
  );
}
