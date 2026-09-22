import { EmptyState, Panel, StatusBadge, formatObjectType, formatUtcDateTime } from '@worldview/ui';
import { displayName } from '../context/index.js';
import { useActions, useAppState } from '../store/store.js';

/**
 * Related tab. Two different relationships, shown together and labelled as such: events
 * the engine genuinely linked to this object, and other objects that merely happen to be
 * nearby. Position is not a relationship, so the nearby list says so rather than
 * implying the runtime found a connection.
 */
export function RelatedPanel() {
  const { world } = useAppState();
  const actions = useActions();
  if (!world.selectedId) return <EmptyState icon="link" title="Select something to see related items" compact />;
  const { objects, events } = world.related;
  if (objects.length === 0 && events.length === 0)
    return (
      <EmptyState
        icon="link"
        title="No related items"
        description="No events are linked to this selection, and nothing else is within 250 km."
        compact
      />
    );
  return (
    <Panel title="Related" subtitle={`${events.length} linked events · ${objects.length} nearby objects`} flush>
      <ul className="wv-related">
        {events.map((e) => (
          <li key={e.id} className="wv-related__item">
            <button
              type="button"
              className="wv-related__button"
              onClick={() => void actions.select(e.id, { kind: 'event', fly: true })}
            >
              <span className="wv-related__title wv-truncate">{e.title}</span>
              <span className="wv-related__meta">
                {formatObjectType(e.type)} · {formatUtcDateTime(e.startAt)}
              </span>
            </button>
            {e.severity ? <StatusBadge kind="severity" value={e.severity} size="sm" /> : null}
          </li>
        ))}
        {objects.length ? (
          <li className="wv-related__heading wv-ctx-muted">
            Nearby — the closest objects within 250 km, whatever their type
          </li>
        ) : null}
        {objects.map((o) => (
          <li key={o.id} className="wv-related__item">
            <button
              type="button"
              className="wv-related__button"
              onClick={() => void actions.select(o.id, { kind: 'object', fly: true })}
            >
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
