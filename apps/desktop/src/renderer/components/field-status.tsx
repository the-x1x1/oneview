import { useEffect } from 'react';
import { Toggle } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { displaySettings } from '../store/display.js';
import { useNow } from '../hooks/use-now.js';
import { fieldStatusItems } from './field-status-model.js';

/** Power and disk are asked again this often while the strip is shown (a sysfs and statfs read). */
const FIELD_REFRESH_MS = 60_000;

/**
 * The field status strip (docs/cyberdeck M5): one line under the top bar — network, this
 * computer's GPS, the aircraft receiver, the mesh, the vault, disk headroom and power — with a
 * switch for each receiver on this computer. Shown when the operator turns it on (or picks the
 * Field profile); it asks for nothing while hidden. Ages tick every five seconds.
 */
export function FieldStatus() {
  const { session, sources, offline } = useAppState();
  const actions = useActions();
  const on = displaySettings(session.settings).fieldStatus === true;
  const nowMs = useNow(5000);

  useEffect(() => {
    if (!on) return;
    void actions.refreshFieldStatus();
    const t = setInterval(() => void actions.refreshFieldStatus(), FIELD_REFRESH_MS);
    return () => clearInterval(t);
  }, [on, actions]);

  if (!on) return null;
  const items = fieldStatusItems(
    {
      workOffline: session.settings?.network?.workOffline === true,
      connection: sources.connection,
      entries: sources.entries,
      vaults: offline.status?.vaults,
      field: offline.field,
    },
    nowMs,
  );
  return (
    <div className="wv-fieldbar" role="status" aria-label="Field status">
      {items.map((item) => (
        <span key={item.id} className={`wv-fieldbar__item wv-fieldbar__item--${item.tone}`} title={item.title}>
          <span className="wv-fieldbar__label">{item.label}</span>
          <span className="wv-fieldbar__value">{item.value}</span>
          {item.source ? (
            <Toggle
              size="sm"
              hideLabel
              label={`${item.label} source ${item.source.enabled ? 'on' : 'off'}`}
              checked={item.source.enabled}
              onChange={(v) => void actions.setSourceEnabled(item.source!.providerId, v)}
            />
          ) : null}
        </span>
      ))}
    </div>
  );
}
