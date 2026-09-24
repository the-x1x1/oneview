import type { SourceHealthEntry } from '@worldview/source-health';

/** The connector a source runs on when it is a definition (ADR-013), else undefined. */
export function connectorOf(entry: Pick<SourceHealthEntry, 'meta'>): string | undefined {
  const c = entry.meta.connector;
  return typeof c === 'string' && c.trim() ? c.trim() : undefined;
}

/** A definition's file name as the Definitions list shows it (without `bundled/`). */
export function definitionFileLabel(file: string): string {
  return file.startsWith('bundled/') ? `${file.slice('bundled/'.length)} (shipped)` : file;
}

/**
 * The connector id (`rest-json`, `geojson`, …) as a small neutral pill beside the source's
 * locality. It sits in the name cell rather than in a column of its own: the sources table
 * is fixed-width and must never scroll sideways, and a long id is cut with an ellipsis.
 */
export function ConnectorBadge({ connector }: { connector: string }) {
  return (
    <span
      className="wv-badge wv-badge--sm wv-connector-badge"
      title={`Connector definition, run by ${connector}`}
      style={{ maxWidth: '100%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
    >
      <span className="wv-visually-hidden">connector </span>
      {connector}
    </span>
  );
}

/** The locality line under a source's name, with the connector badge when it has one. */
export function SourceLocalityLine({ entry }: { entry: Pick<SourceHealthEntry, 'locality' | 'meta'> }) {
  const connector = connectorOf(entry);
  if (!connector) return <span className="wv-sources__locality">{entry.locality}</span>;
  return (
    <span
      className="wv-sources__locality"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', minWidth: 0 }}
    >
      <span>{entry.locality}</span>
      <ConnectorBadge connector={connector} />
    </span>
  );
}
