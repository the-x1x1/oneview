import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SourceHealthEntry } from '@worldview/source-health';
import { Button, FieldList, Toggle } from '@worldview/ui';
import { ConnectorBadge, definitionFileLabel } from './sources-connector-badge.js';
import {
  DefinitionsController,
  definitionRows,
  definitionsSummary,
  type DefinitionRow,
  type DefinitionsClient,
  type DefinitionsState,
} from './sources-definitions-model.js';

/** Long file names and paths wrap inside the rail instead of widening it (no sideways scroll). */
const WRAP = { minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' } as const;
const LIST = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
} as const;

/** One controller per client for the life of the panel; the listing is read once on mount. */
export function useDefinitions(client: DefinitionsClient): {
  controller: DefinitionsController;
  state: DefinitionsState;
} {
  const controller = useMemo(() => new DefinitionsController(client), [client]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => {
    void controller.load();
  }, [controller]);
  return { controller, state };
}

export interface DefinitionsSectionProps {
  controller: DefinitionsController;
  state: DefinitionsState;
  entries: readonly Pick<SourceHealthEntry, 'providerId' | 'enabled'>[];
  onAddSource: () => void;
}

/**
 * The operator's connector-definition folder in Sources: where it is, Open folder, Reload,
 * Add source, and every file with its switch or the reasons it was refused. Nothing is
 * shown while the first listing is on its way, and nothing when the runtime has no folder
 * (demo mode reports `folder: null`), so the panel reads exactly as it did before.
 */
export function DefinitionsSection({ controller, state, entries, onAddSource }: DefinitionsSectionProps) {
  if (state.status === 'loading') return null;
  if (state.status === 'failed') {
    return (
      <section className="wv-definitions" aria-label="Definitions" style={{ padding: 'var(--wv-space-3)' }}>
        <p className="wv-form-error" role="alert" style={WRAP}>
          The definition folder could not be listed: {state.error}
        </p>
        <Button size="sm" icon="refresh" onClick={() => void controller.load()}>
          Try again
        </Button>
      </section>
    );
  }
  const folder = state.listing?.folder ?? null;
  if (!state.listing || folder === null) return null;

  const rows = definitionRows(state.listing, entries);
  return (
    <section
      className="wv-definitions wv-source-detail"
      aria-labelledby="wv-definitions-title"
      style={{ padding: 'var(--wv-space-3)', borderTop: '1px solid var(--wv-border)' }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: '2px', ...WRAP }}>
        <h3 id="wv-definitions-title" className="wv-caps">
          Definitions
        </h3>
        <span className="wv-credential__state">{definitionsSummary(rows)}</span>
      </header>
      <FieldList rows={[{ label: 'Folder', value: folder, mono: true, title: folder }]} />
      <div className="wv-source-detail__controls">
        <Button size="sm" icon="external" onClick={() => void controller.openFolder()} disabled={state.busy !== null}>
          {state.busy === 'open' ? 'Opening…' : 'Open folder'}
        </Button>
        <Button size="sm" icon="refresh" onClick={() => void controller.reload()} disabled={state.busy !== null}>
          {state.busy === 'reload' ? 'Reloading…' : 'Reload'}
        </Button>
        <Button size="sm" icon="plus" variant="primary" onClick={onAddSource}>
          Add source
        </Button>
      </div>
      <p role="status" aria-live="polite" className="wv-credential__state" style={WRAP}>
        {state.notice ?? ''}
      </p>
      {state.error ? (
        <p role="alert" className="wv-form-error" style={WRAP}>
          {state.error}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="wv-ctx-muted" style={WRAP}>
          No definition files yet. Add a source, or put a definition file in the folder and reload.
        </p>
      ) : (
        <ul aria-label="Definition files" style={LIST}>
          {rows.map((row) => (
            <DefinitionItem
              key={row.file}
              row={row}
              pending={state.pending.includes(row.file)}
              onToggle={(on) => void controller.setEnabled(row.file, on)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const STATE_TEXT: Record<DefinitionRow['state'], string> = {
  enabled: 'enabled',
  disabled: 'disabled',
  rejected: 'rejected',
};

function DefinitionItem({
  row,
  pending,
  onToggle,
}: {
  row: DefinitionRow;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const label = definitionFileLabel(row.file);
  return (
    <li
      className="wv-definition"
      data-file={row.file}
      data-state={row.state}
      style={{ display: 'flex', flexDirection: 'column', gap: '4px', ...WRAP }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', ...WRAP }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', ...WRAP }}>
          <span className="wv-mono" style={WRAP}>
            {label}
          </span>
          <span className="wv-sources__locality" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', ...WRAP }}>
            <span>{row.id ? `${row.id} · ${STATE_TEXT[row.state]}` : STATE_TEXT[row.state]}</span>
            {row.connector ? <ConnectorBadge connector={row.connector} /> : null}
          </span>
        </div>
        {row.switchable ? (
          <Toggle
            size="sm"
            hideLabel
            label={`${row.state === 'enabled' ? 'Disable' : 'Enable'} ${label}`}
            checked={row.state === 'enabled'}
            disabled={pending}
            onChange={onToggle}
          />
        ) : null}
      </div>
      {row.problems.length ? (
        <ul aria-label={`Why ${label} was rejected`} style={{ ...LIST, gap: '2px' }}>
          {row.problems.map((p, i) => (
            <li key={i} className="wv-form-error" style={WRAP}>
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      {row.warnings.length ? (
        <details>
          <summary className="wv-credential__state">
            {row.warnings.length} {row.warnings.length === 1 ? 'note' : 'notes'} from the validator
          </summary>
          <ul style={{ ...LIST, gap: '2px' }}>
            {row.warnings.map((w, i) => (
              <li key={i} className="wv-credential__state" style={WRAP}>
                {w}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}
