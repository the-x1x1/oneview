import { useState } from 'react';
import { Button, formatBytes } from '@worldview/ui';
import type { OfflineStatus, VaultHealthSummary } from '@worldview/ipc-contract';
import { useActions } from '../store/store.js';
import { installLine } from './pack-trust.js';

/**
 * Settings → Offline packs → Data vaults (docs/cyberdeck, M2): folders outside the app's own —
 * an external SSD — that hold world packs. Each says whether it is connected, how much room it
 * has, and what can be done with it right now. Settings, keys and history stay on this computer.
 */

/** The state word and the tone it is shown in. */
export function vaultStateText(v: Pick<VaultHealthSummary, 'state'>): { text: string; tone: 'ok' | 'muted' | 'bad' } {
  switch (v.state) {
    case 'ready':
      return { text: 'Connected', tone: 'ok' };
    case 'read-only':
      return { text: 'Connected, read-only', tone: 'muted' };
    case 'low-space':
      return { text: 'Connected, nearly full', tone: 'muted' };
    case 'absent':
      return { text: 'Not connected', tone: 'muted' };
    case 'foreign':
      return { text: 'A different drive', tone: 'bad' };
    case 'error':
      return { text: 'Cannot be checked', tone: 'bad' };
  }
}

/** The second line: where it is and how much room is left, or what is wrong. */
export function vaultDetail(v: VaultHealthSummary, packCount: number): string {
  const packs = `${packCount} pack${packCount === 1 ? '' : 's'}`;
  if (v.state === 'ready' || v.state === 'read-only' || v.state === 'low-space') {
    const room =
      v.freeBytes !== undefined && v.totalBytes !== undefined
        ? ` · ${formatBytes(v.freeBytes)} free of ${formatBytes(v.totalBytes)}`
        : '';
    return `${v.path} · ${packs}${room}${v.state === 'ready' ? '' : ` — ${v.message}`}`;
  }
  return `${v.message} · ${packs} remembered`;
}

export function DataVaults({ status }: { status: OfflineStatus | null | undefined }) {
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ vaultId: string; r: { installed: string | null; issues: string[] } } | null>(
    null,
  );
  // Hosts from before data vaults send no `vaults`: nothing to show, and no button to offer.
  if (!status?.vaults) return null;
  const vaults = status.vaults;
  return (
    <div className="wv-vaults">
      <h4 className="wv-vaults__title">Data vaults</h4>
      <p className="wv-ctx-muted">
        Folders on an external drive for large packs. WorldView marks a folder when you add it and only ever uses it
        while that mark is there, so an unplugged drive is never written to by mistake. Settings, keys and history stay
        on this computer.
      </p>
      {vaults.length ? (
        <ul className="wv-vaults__list">
          {vaults.map((v) => {
            const state = vaultStateText(v);
            const packs = status.packs.filter((p) => p.vault?.id === v.id).length;
            const line = result?.vaultId === v.id ? installLine(result.r) : undefined;
            return (
              <li key={v.id} className="wv-vaults__vault">
                <p>
                  <strong>{v.label}</strong>{' '}
                  <span className={`wv-vaults__state wv-vaults__state--${state.tone}`}>{state.text}</span>
                </p>
                <p className="wv-ctx-muted">{vaultDetail(v, packs)}</p>
                <Button
                  size="sm"
                  icon="upload"
                  disabled={busy || v.state !== 'ready'}
                  onClick={() => {
                    setBusy(true);
                    void actions.installPackToVault(v.id).then((r) => {
                      setBusy(false);
                      setResult({ vaultId: v.id, r });
                    });
                  }}
                >
                  Install pack onto it
                </Button>
                <Button size="sm" variant="ghost" icon="close" onClick={() => void actions.removeDataVault(v.id)}>
                  Stop using
                </Button>
                {line ? (
                  <p className={`wv-pack-install__result wv-pack-install__result--${line.tone}`}>{line.text}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <Button size="sm" icon="plus" disabled={busy || vaults.length >= 8} onClick={() => void actions.addDataVault()}>
        Add a data vault…
      </Button>
    </div>
  );
}
