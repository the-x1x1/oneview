import {
  Button,
  EmptyState,
  FieldList,
  LoadingState,
  Panel,
  Section,
  StatusBadge,
  formatObjectType,
  formatUtcDateTime,
} from '@worldview/ui';
import { contextRegistry, displayName } from '../context/index.js';
import { useActions, useAppState } from '../store/store.js';
import { useNow } from '../hooks/use-now.js';
import { isCollected } from '../store/collections.js';

/** Selection panel: composed from the context registry for objects; event details for events. */
export function SelectionPanel() {
  const { world, sources, collections } = useAppState();
  const actions = useActions();
  const nowMs = useNow(5000);

  if (!world.selectedId) {
    return (
      <EmptyState
        icon="target"
        title="Nothing selected"
        description="Pick something on the map, choose a feed item, or search for a place, callsign or event."
        action={{ label: 'Open command palette', onClick: () => actions.openPalette() }}
      />
    );
  }

  // Collect says where it adds, and once the selection is there it says so instead of
  // adding it again: the click used to give no sign it had worked, so it got clicked twice.
  const active = collections.collections.find((c) => c.id === collections.activeId);
  const collected = active ? isCollected(active.items, world.selectedId) : false;
  const addTo = active ? (
    <Button
      size="sm"
      variant="ghost"
      icon={collected ? 'check' : 'bookmark'}
      title={collected ? `Already in “${active.name}”` : `Add to “${active.name}”`}
      disabled={collected}
      onClick={() => void actions.addSelectionToCollection(active.id)}
    >
      {collected ? 'Collected' : 'Collect'}
    </Button>
  ) : null;

  if (world.selectedKind === 'event') {
    const ev = world.selectedEvent;
    if (!ev) return <LoadingState label="Loading event" />;
    return (
      <Panel title={ev.title} subtitle={formatObjectType(ev.type)} actions={addTo}>
        <div className="wv-ctx-badges">
          {ev.severity ? <StatusBadge kind="severity" value={ev.severity} /> : null}
          <StatusBadge kind="confidence" value={ev.confidence} />
          {ev.provenance.origin === 'recorded' ? <StatusBadge kind="recorded" /> : null}
        </div>
        <Section title="Summary">
          <p className="wv-ctx-summary">{ev.summary}</p>
        </Section>
        <Section title="Timing">
          <FieldList
            rows={[
              { label: 'Started', value: formatUtcDateTime(ev.startAt) },
              { label: 'Ended', value: ev.endAt ? formatUtcDateTime(ev.endAt) : undefined },
              { label: 'Identifier', value: ev.id, mono: true },
            ]}
          />
        </Section>
        <Section title="Sources">
          <FieldList
            rows={[
              { label: 'Source', value: ev.provenance.sourceName },
              { label: 'Attribution', value: ev.provenance.attribution },
              { label: 'Observations', value: String(ev.observationRefs.length) },
            ]}
          />
        </Section>
        {world.related.objects.length ? (
          <Section title="Objects">
            <ul className="wv-ctx-related">
              {world.related.objects.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    className="wv-ctx-link"
                    onClick={() => void actions.select(o.id, { kind: 'object', fly: true })}
                  >
                    {displayName(o)}
                  </button>{' '}
                  <span className="wv-ctx-muted">{formatObjectType(o.type)}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </Panel>
    );
  }

  const object = world.selectedObject;
  if (!object) return <LoadingState label="Loading object" />;
  const sections = contextRegistry.sectionsFor(object.type);
  const props = { object, track: world.track, related: world.related, sources: sources.entries, actions, nowMs };
  return (
    <Panel title={displayName(object)} subtitle={formatObjectType(object.type)} actions={addTo}>
      {sections.map((s) => {
        const body = s.render(props);
        if (body === null || body === undefined || body === false) return null;
        return (
          <Section key={s.id} title={s.title}>
            {body}
          </Section>
        );
      })}
    </Panel>
  );
}
