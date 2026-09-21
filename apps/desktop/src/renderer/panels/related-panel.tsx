import { EmptyState, Panel, StatusBadge, formatObjectType, formatUtcDateTime } from '@worldview/ui';
import { displayName } from '../context/index.js';
import { useActions, useAppState } from '../store/store.js';

/** Related tab: objects and events the runtime links to the current selection (world.related). */
export function RelatedPanel() {
  const { world } = useAppState();
  const actions = useActions();
  if (!world.selectedId) return <EmptyState icon="link" title="Select something to see related items" compact />;
  const { objects, events } = world.related;
  if (objects.length === 0 && events.length === 0) return <EmptyState icon="link" title="No related items" description="The runtime reported no linked objects or events for this selection." compact />;
  return (
    <Panel title="Related" subtitle={`${events.length} events · ${objects.length} objects`} flush>
      <ul className="wv-related">
        {events.map((e) => (
          <li key={e.id} className="wv-related__item">
            <button type="button" className="wv-related__button" onClick={() => void actions.select(e.id, { kind: 'event', fly: true })}>
              <span className="wv-related__title wv-truncate">{e.title}</span>
              <span className="wv-related__meta">{formatObjectType(e.type)} · {formatUtcDateTime(e.startAt)}</span>
            </button>
            {e.severity ? <StatusBadge kind="severity" value={e.severity} size="sm" /> : null}
          </li>
        ))}
        {objects.map((o) => (
          <li key={o.id} className="wv-related__item">
            <button type="button" className="wv-related__button" onClick={() => void actions.select(o.id, { kind: 'object', fly: true })}>
              <span className="wv-related__title wv-truncate">{displayName(o)}</span>
              <span className="wv-related__meta">{formatObjectType(o.type)}</span>
            </button>
            <StatusBadge kind="freshness" value={o.freshness} size="sm" />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
