import { useEffect } from 'react';
import { Icon, IconButton, StatusBadge } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';

/** "RECORDED DATA" banner (directive §92) — shown whenever app.info.demoMode is true. */
export function DemoBanner() {
  const { session } = useAppState();
  if (!session.appInfo?.demoMode) return null;
  return (
    <div className="wv-demo-banner" role="status" aria-live="polite">
      <StatusBadge kind="recorded" />
      <span>Demo mode — everything shown is recorded or synthetic data. No live sources are contacted.</span>
    </div>
  );
}

/** Offline notice when the connection state is OFFLINE (per-source detail lives in the Sources tab). */
export function OfflineNotice() {
  const { sources, offline } = useAppState();
  const actions = useActions();
  if (sources.connection?.state !== 'OFFLINE') return null;
  const caps = offline.status?.capabilities;
  const available = caps
    ? Object.entries(caps)
        .filter(([, v]) => v)
        .map(([k]) => k.replace(/([A-Z])/g, ' $1').toLowerCase())
    : [];
  return (
    <div className="wv-offline-notice" role="status">
      <Icon name="offline" size={14} />
      <span>
        Offline — remote sources are unreachable{sources.connection.networkOnline ? '' : ' (no network)'}. Cached data
        is labelled. {available.length ? `Available locally: ${available.join(', ')}.` : ''}
      </span>
      <button type="button" className="wv-ctx-link" onClick={() => actions.setContextTab('sources')}>
        Source states
      </button>
    </div>
  );
}

/** Notification toasts from the runtime `notification` channel and shell actions; auto-dismiss after 8 s. */
export function Notifications() {
  const { ui } = useAppState();
  const actions = useActions();
  const first = ui.notifications[0];
  useEffect(() => {
    if (!first) return;
    const t = setTimeout(() => actions.dismissNotification(first.id), 8000);
    return () => clearTimeout(t);
  }, [first, actions]);
  if (ui.notifications.length === 0) return null;
  return (
    <div className="wv-toasts" aria-live="polite">
      {ui.notifications.map((n) => (
        <div key={n.id} className="wv-toast" role="status">
          <StatusBadge kind="severity" value={n.severity} size="sm" />
          <div className="wv-toast__text">
            <span className="wv-toast__title">{n.title}</span>
            <span className="wv-toast__body">{n.body}</span>
          </div>
          {n.eventId ? (
            <button
              type="button"
              className="wv-ctx-link"
              onClick={() => {
                void actions.select(n.eventId!, { kind: 'event', fly: true });
                actions.dismissNotification(n.id);
              }}
            >
              Show
            </button>
          ) : null}
          <IconButton
            icon="close"
            label="Dismiss notification"
            size="sm"
            onClick={() => actions.dismissNotification(n.id)}
          />
        </div>
      ))}
    </div>
  );
}
