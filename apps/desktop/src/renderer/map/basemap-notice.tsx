import { useState } from 'react';
import { Button, Icon, IconButton } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { missingBasemapReason } from '../map-providers.js';

/**
 * Says so when the active mode has no basemap (map-providers.ts `missingBasemapReason`).
 * A fresh install's 2D is the case that matters: the renderer is deliberately handed
 * nothing, and a dark field with dots on it reads as broken rather than as "choose a map".
 * Dismissing it lasts until the mode or the basemap setting changes.
 */
export function BasemapNotice() {
  const { session, ui } = useAppState();
  const actions = useActions();
  const configuredId = session.settings?.basemapId;
  const mode = ui.activeMode;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const missing = missingBasemapReason(session.mapProviders, configuredId, mode);
  const key = `${mode}:${configuredId ?? ''}`;
  if (!missing || dismissed === key) return null;
  return (
    <div className="wv-map__notice" role="status" aria-live="polite">
      <div className="wv-map__notice-head">
        <Icon name="info" size={16} />
        <strong>No {mode} basemap</strong>
        <IconButton icon="close" label="Dismiss" size="sm" onClick={() => setDismissed(key)} />
      </div>
      {missing.reasons.map((r) => (
        <p key={r}>{r}</p>
      ))}
      <p>
        {missing.alternatives.length
          ? `Available for ${mode}: ${missing.alternatives.join(', ')}.`
          : `Nothing can draw a ${mode} basemap right now.`}
      </p>
      <Button size="sm" variant="secondary" icon="settings" onClick={() => actions.openDialog('settings')}>
        Choose a basemap
      </Button>
    </div>
  );
}
