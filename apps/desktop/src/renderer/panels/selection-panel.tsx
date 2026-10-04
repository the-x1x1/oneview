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
import { aftershockSequence, eventHistory, eventLinks, eventSeries, seriesPath } from './event-links.js';

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

  if (world.selectedMissing)
    return (
      <EmptyState
        icon="target"
        title="Not in the world now"
        description="Its source no longer reports it (an earthquake past the feed's window, an aircraft that landed). Scrub the timeline back to when it was seen to show it as it was."
        action={{ label: 'Clear selection', onClick: () => void actions.select(null) }}
      />
    );

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
        {eventHistory(ev).rows.length ? (
          <Section title="History">
            <SeriesChart series={eventSeries(ev)} />
            <ul className="wv-ctx-history">
              {eventHistory(ev).rows.map((r) => (
                <li key={r.at}>
                  <span className="wv-ctx-muted">{formatUtcDateTime(r.at)}</span> {r.text}
                </li>
              ))}
              {eventHistory(ev).earlier ? (
                <li className="wv-ctx-muted">and {eventHistory(ev).earlier} earlier</li>
              ) : null}
            </ul>
          </Section>
        ) : null}
        <AftershockSection
          sequence={aftershockSequence(ev, [...world.events.values(), ...world.related.events])}
          onSelect={(id) => void actions.select(id, { kind: 'event', fly: true })}
        />
        {eventLinks(ev).length ? (
          <Section title="Related events">
            <ul className="wv-ctx-related">
              {eventLinks(ev).map((l) => (
                <li key={`${l.label}-${l.eventId}`}>
                  <span className="wv-ctx-muted">{l.label}</span>{' '}
                  <button
                    type="button"
                    className="wv-ctx-link"
                    onClick={() => void actions.select(l.eventId, { kind: 'event', fly: true })}
                  >
                    {l.eventId.split(':').slice(2).join(':')}
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
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
  const props = {
    object,
    track: world.track,
    flight: world.flight,
    related: world.related,
    sources: sources.entries,
    actions,
    nowMs,
  };
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

/** A mainshock's aftershocks: how many, the largest, over what span, the newest twelve. */
function AftershockSection({
  sequence,
  onSelect,
}: {
  sequence: ReturnType<typeof aftershockSequence>;
  onSelect: (eventId: string) => void;
}) {
  if (!sequence) return null;
  const n = sequence.count;
  return (
    <Section title="Aftershocks">
      <p className="wv-ctx-summary">
        {n} aftershock{n === 1 ? '' : 's'}
        {sequence.largest ? `, the largest M${sequence.largest.magnitude.toFixed(1)}` : ''}, from{' '}
        {formatUtcDateTime(sequence.first)} to {formatUtcDateTime(sequence.last)}.
      </p>
      <ul className="wv-ctx-history">
        {sequence.rows.map((r) => (
          <li key={r.eventId}>
            <span className="wv-ctx-muted">{formatUtcDateTime(r.at)}</span>{' '}
            <button type="button" className="wv-ctx-link" onClick={() => onSelect(r.eventId)}>
              {r.magnitude !== undefined ? `M${r.magnitude.toFixed(1)}` : r.title}
            </button>
          </li>
        ))}
        {sequence.earlier ? <li className="wv-ctx-muted">and {sequence.earlier} earlier</li> : null}
      </ul>
    </Section>
  );
}

/** A small line of an event's own number over time (a fire's detections, a storm's wind). */
function SeriesChart({ series }: { series: ReturnType<typeof eventSeries> }) {
  if (!series) return null;
  const first = series.points[0]!;
  const last = series.points[series.points.length - 1]!;
  const unit = series.unit ? ` ${series.unit}` : '';
  const caption = `${series.label}: ${first.v}${unit} → ${last.v}${unit}`;
  return (
    <figure className="wv-event-series" style={{ margin: '0 0 8px' }}>
      <svg
        viewBox="0 0 1000 60"
        preserveAspectRatio="none"
        role="img"
        aria-label={caption}
        style={{ width: '100%', height: 48, display: 'block' }}
      >
        <path
          d={seriesPath(series.points, 1000, 56)}
          transform="translate(0,2)"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="wv-ctx-muted">{caption}</figcaption>
    </figure>
  );
}
