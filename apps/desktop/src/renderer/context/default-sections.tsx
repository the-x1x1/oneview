import { classifyConfidence, haversineMeters } from '@worldview/world-model';
import { Button, FieldList, SourceBadge, StatusBadge, formatAgo, formatAltitude, formatCoordinates, formatDistance, formatDuration, formatHeading, formatObjectType, formatSpeed, formatUtcDateTime, formatVerticalRate } from '@worldview/ui';
import { contextRegistry, type ContextSection } from './registry.js';
import { displayName, safeHttpsUrl } from './props.js';

/**
 * Default sections for every object type (directive §62): Identity, Position, Freshness &
 * confidence (class only — never the raw score), Sources (attribution + observation time),
 * History (track summary) and Related. Type-specific sections live in ./sections/*.tsx.
 */
export const DEFAULT_SECTIONS: ContextSection[] = [
  {
    id: 'identity',
    title: 'Identity',
    render: ({ object }) => (
      <FieldList rows={[
        { label: 'Name', value: displayName(object) },
        { label: 'Type', value: formatObjectType(object.type) },
        { label: 'Identifier', value: object.id, mono: true },
        ...Object.entries(object.labels).filter(([k]) => !['name', 'callsign', 'title'].includes(k)).map(([k, v]) => ({ label: formatObjectType(k), value: v })),
      ]} />
    ),
  },
  {
    id: 'position',
    title: 'Position',
    render: ({ object }) => {
      const p = object.position;
      if (!p && !object.geometry) return null;
      const altUnit = object.type === 'aircraft' ? 'ft' : 'm';
      const speedUnit = object.type === 'aircraft' || object.type === 'vessel' ? 'kt' : 'km/h';
      return (
        <FieldList rows={[
          { label: 'Coordinates', value: p ? formatCoordinates(p.latitude, p.longitude) : `${object.geometry?.type} geometry` },
          { label: 'Altitude', value: p && p.altitudeM !== undefined && p.altitudeM >= 0 ? `${formatAltitude(p.altitudeM, altUnit)}${p.altitudeDatum ? ` (${p.altitudeDatum})` : ''}` : undefined },
          { label: 'Accuracy', value: p?.accuracyM !== undefined ? `±${formatDistance(p.accuracyM)}` : undefined },
          { label: 'Speed', value: formatSpeed(object.motion?.speedMps, speedUnit) },
          { label: 'Heading', value: formatHeading(object.motion?.headingDegrees) },
          { label: 'Vertical rate', value: formatVerticalRate(object.motion?.verticalSpeedMps) },
        ]} />
      );
    },
  },
  {
    id: 'freshness',
    title: 'Freshness & confidence',
    render: ({ object, nowMs }) => (
      <div className="wv-ctx-badges">
        <StatusBadge kind="freshness" value={object.freshness} title={`Observed ${formatAgo(object.observedAt, nowMs)}`} />
        <StatusBadge kind="confidence" value={classifyConfidence(object.confidence)} title="System-generated metadata, not scientific certainty" />
        {object.provenance.origin === 'recorded' ? <StatusBadge kind="recorded" /> : null}
        {object.provenance.origin === 'cached' ? <StatusBadge kind="cached" /> : null}
        <FieldList rows={[
          { label: 'Observed', value: `${formatUtcDateTime(object.observedAt)} · ${formatAgo(object.observedAt, nowMs)}` },
          { label: 'Updated', value: formatAgo(object.updatedAt, nowMs) },
          { label: 'Valid until', value: object.validUntil ? formatUtcDateTime(object.validUntil) : undefined },
        ]} />
      </div>
    ),
  },
  {
    id: 'sources',
    title: 'Sources',
    render: ({ object, sources, actions, nowMs }) => {
      const byProvider = new Map<string, string>();
      for (const ref of object.sourceRefs) if (!byProvider.has(ref.providerId)) byProvider.set(ref.providerId, ref.observedAt);
      const terms = safeHttpsUrl(object.provenance.termsUrl);
      return (
        <div className="wv-ctx-sources">
          {[...byProvider.entries()].map(([providerId, observedAt]) => {
            const entry = sources.find((s) => s.providerId === providerId);
            return (
              <div key={providerId} className="wv-ctx-source">
                <SourceBadge name={entry?.name ?? object.provenance.sourceName} status={entry?.health.status ?? 'STARTING'} providerId={providerId} onClick={() => actions.openSource(providerId)} />
                <span className="wv-ctx-source__time">observed {formatAgo(observedAt, nowMs)}</span>
              </div>
            );
          })}
          <FieldList rows={[
            { label: 'Attribution', value: object.provenance.attribution ?? sources.find((s) => s.providerId === object.provenance.providerId)?.meta.attribution },
            { label: 'Origin', value: object.provenance.origin },
            { label: 'License', value: object.provenance.licenseId },
          ]} />
          {terms ? <Button size="sm" variant="ghost" icon="external" onClick={() => void actions.openExternal(terms)}>Terms of use</Button> : null}
        </div>
      );
    },
  },
  {
    id: 'history',
    title: 'History',
    render: ({ track }) => {
      if (track.length < 2) return null;
      const first = track[0]!, last = track[track.length - 1]!;
      let distance = 0;
      for (let i = 1; i < track.length; i++) distance += haversineMeters(track[i - 1]!, track[i]!);
      const span = Date.parse(last.observedAt) - Date.parse(first.observedAt);
      return (
        <FieldList rows={[
          { label: 'Track points', value: String(track.length) },
          { label: 'Span', value: formatDuration(span) },
          { label: 'Distance', value: formatDistance(distance) },
          { label: 'From', value: formatUtcDateTime(first.observedAt) },
          { label: 'To', value: formatUtcDateTime(last.observedAt) },
        ]} />
      );
    },
  },
  {
    id: 'related',
    title: 'Related',
    render: ({ related, actions }) => {
      if (related.objects.length === 0 && related.events.length === 0) return null;
      return (
        <ul className="wv-ctx-related">
          {related.events.map((e) => (
            <li key={e.id}><button type="button" className="wv-ctx-link" onClick={() => void actions.select(e.id, { kind: 'event', fly: true })}>{e.title}</button> <span className="wv-ctx-muted">{formatObjectType(e.type)}</span></li>
          ))}
          {related.objects.map((o) => (
            <li key={o.id}><button type="button" className="wv-ctx-link" onClick={() => void actions.select(o.id, { kind: 'object', fly: true })}>{displayName(o)}</button> <span className="wv-ctx-muted">{formatObjectType(o.type)}</span></li>
          ))}
        </ul>
      );
    },
  },
];

contextRegistry.register('*', DEFAULT_SECTIONS);
