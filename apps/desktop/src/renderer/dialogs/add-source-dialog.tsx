import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { DefinitionsReload } from '@worldview/ipc-contract';
import { Button, Dialog, FieldList } from '@worldview/ui';
import { ConnectorBadge } from '../panels/sources-connector-badge.js';
import { waitingStyle } from '../panels/sources-definitions.js';
import { AddSourceFlow, type AddSourceState, type DefinitionsClient } from '../panels/sources-definitions-model.js';

const WRAP = { minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' } as const;
const STACK = { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 } as const;
const ROW = { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end' } as const;

export interface AddSourceDialogProps {
  client: DefinitionsClient;
  /** Ids no new definition may take (every registered source and every file in the folder). */
  takenIds: () => ReadonlySet<string>;
  onSaved: (file: string, listing: DefinitionsReload) => void;
  /** Resolves to the reason the folder could not be opened, or null. */
  onOpenFolder: () => Promise<string | null>;
  onClose: () => void;
  /** Tests start the dialog at a given step; the app always starts at the address. */
  flow?: AddSourceFlow | undefined;
}

/**
 * "Add source": an https address → the main process fetches one sample and drafts a
 * definition the way `connector:add` does → the validator's verdict → Save writes it into
 * the operator's folder, disabled. Editing the JSON happens in the operator's own editor
 * (Open folder), never here. Mounted only while open, so every opening starts afresh.
 *
 * It can be closed at any time: a draft still being fetched is dropped, and a save still
 * being written lands in the Definitions list anyway. Controls that are waiting keep focus
 * (`aria-disabled`, repeats ignored); each step moves focus to what it shows, and one live
 * region says what happened.
 */
export function AddSourceDialog({ client, takenIds, onSaved, onOpenFolder, onClose, flow }: AddSourceDialogProps) {
  // One flow per opening. The callbacks are read through refs, so a parent that re-renders
  // with new functions neither restarts the flow nor leaves it calling stale ones.
  const takenRef = useRef(takenIds);
  const savedRef = useRef(onSaved);
  takenRef.current = takenIds;
  savedRef.current = onSaved;
  const [model] = useState(
    () =>
      flow ??
      new AddSourceFlow(
        client,
        () => takenRef.current(),
        (file, listing) => savedRef.current(file, listing),
      ),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => {
    model.attach();
    return () => model.dispose();
  }, [model]);

  // A new step replaces the controls, so focus is moved to what the step shows.
  const stepRef = useRef<HTMLDivElement | null>(null);
  // null at first, so the opening step takes focus too (after the Dialog's own effect).
  const shownStep = useRef<AddSourceState['step'] | null>(null);
  useEffect(() => {
    if (shownStep.current === state.step) return;
    shownStep.current = state.step;
    stepRef.current?.querySelector<HTMLElement>('[data-step-focus]')?.focus();
  }, [state.step]);

  return (
    <Dialog
      open
      title="Add source"
      size="md"
      onClose={onClose}
      description="Draft a connector definition from one sample of a public https address. Nothing is written until you save, and a saved source starts disabled."
    >
      <p role="status" aria-live="polite" className="wv-visually-hidden">
        {announce(state)}
      </p>
      <div ref={stepRef}>
        {state.step === 'url' ? <UrlStep model={model} state={state} onClose={onClose} /> : null}
        {state.step === 'draft' ? <DraftStep model={model} state={state} onClose={onClose} /> : null}
        {state.step === 'saved' ? (
          <SavedStep model={model} state={state} onOpenFolder={onOpenFolder} onClose={onClose} />
        ) : null}
      </div>
    </Dialog>
  );
}

/** The dialog's one live region: what just happened, for a screen reader. */
export function announce(state: AddSourceState): string {
  switch (state.step) {
    case 'url':
      return state.busy ? 'Fetching the sample and drafting.' : '';
    case 'draft':
      if (state.busy) return 'Saving.';
      if (state.error) return '';
      return state.draft.validation.ok
        ? `Draft ready: ${state.draft.connector}, valid, ${state.draft.todo.length} to decide.`
        : `Draft ready: ${state.draft.connector}, does not validate and cannot be saved.`;
    case 'saved':
      return state.enabled ? `Saved ${state.file}. It is on.` : `Saved ${state.file}, disabled.`;
  }
}

function UrlStep({
  model,
  state,
  onClose,
}: {
  model: AddSourceFlow;
  state: Extract<AddSourceState, { step: 'url' }>;
  onClose: () => void;
}) {
  const id = useId();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void model.draft();
  };
  return (
    <form style={STACK} onSubmit={submit} aria-busy={state.busy} noValidate>
      <label className="wv-field" htmlFor={`${id}-url`}>
        Sample address
        <input
          id={`${id}-url`}
          className="wv-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.org/stations.geojson"
          data-step-focus
          value={state.url}
          readOnly={state.busy}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={`${id}-help${state.error ? ` ${id}-error` : ''}`}
          onChange={(e) => model.setUrl(e.target.value)}
        />
      </label>
      <p id={`${id}-help`} className="wv-credential__state" style={WRAP}>
        JSON, GeoJSON or CSV. The app fetches it once, from a public host, and proposes a definition — the id, the
        position, the time and the fields it recognised; everything it could not decide is listed for you to finish.
      </p>
      {state.error ? (
        <p id={`${id}-error`} role="alert" className="wv-form-error" style={WRAP}>
          {state.error}
        </p>
      ) : null}
      <div style={ROW}>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!state.busy && !state.url.trim()}
          aria-disabled={state.busy || undefined}
        >
          {state.busy ? 'Drafting…' : 'Draft'}
        </Button>
      </div>
    </form>
  );
}

function DraftStep({
  model,
  state,
  onClose,
}: {
  model: AddSourceFlow;
  state: Extract<AddSourceState, { step: 'draft' }>;
  onClose: () => void;
}) {
  const id = useId();
  const { draft } = state;
  const idProblem = model.idProblem();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void model.save();
  };
  return (
    <form style={STACK} onSubmit={submit} aria-busy={state.busy} noValidate>
      <p className="wv-credential__state" tabIndex={-1} data-step-focus style={WRAP}>
        Drafted from one sample. Check it, choose the id, then save.
      </p>
      <FieldList
        rows={[
          { label: 'Address', value: state.url, mono: true },
          { label: 'Connector', value: <ConnectorBadge connector={draft.connector} /> },
          {
            label: 'Validation',
            value: draft.validation.ok
              ? 'valid'
              : `does not validate (${draft.validation.errors.length} ${draft.validation.errors.length === 1 ? 'error' : 'errors'})`,
          },
        ]}
      />
      {draft.validation.errors.length ? (
        <DraftList
          title="Why it cannot be saved"
          items={draft.validation.errors}
          className="wv-form-error"
          note="Draft another address, or write the definition by hand in the folder."
        />
      ) : null}
      <label className="wv-field" htmlFor={`${id}-id`}>
        Source id
        <input
          id={`${id}-id`}
          className="wv-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={state.id}
          readOnly={state.busy}
          aria-invalid={idProblem ? true : undefined}
          aria-describedby={`${id}-id-help`}
          onChange={(e) => model.setId(e.target.value)}
        />
      </label>
      <p id={`${id}-id-help`} className={idProblem ? 'wv-form-error' : 'wv-credential__state'} style={WRAP}>
        {idProblem ?? `Will be saved as ${state.id.trim()}.json in your folder.`}
      </p>
      {draft.todo.length ? (
        <DraftList
          title="Still to do before you enable it"
          items={draft.todo}
          className="wv-credential__state"
          note="Edit the file in your own editor after saving; the source stays disabled until you switch it on."
        />
      ) : null}
      {draft.validation.warnings.length ? (
        <DraftList title="Validator notes" items={draft.validation.warnings} className="wv-credential__state" />
      ) : null}
      {draft.notes.length ? (
        <DraftList title="What the drafter found" items={draft.notes} className="wv-credential__state" />
      ) : null}
      <details>
        <summary className="wv-credential__state">Definition as drafted</summary>
        <pre
          className="wv-mono"
          style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 'var(--wv-text-xs)' }}
        >
          {JSON.stringify(draft.definition, null, 2)}
        </pre>
      </details>
      {state.error ? (
        <p role="alert" className="wv-form-error" style={WRAP}>
          {state.error}
        </p>
      ) : null}
      <div style={ROW}>
        <Button
          onClick={() => model.startOver()}
          aria-disabled={state.busy || undefined}
          style={waitingStyle(state.busy)}
        >
          Start over
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!state.busy && !model.canSave()}
          aria-disabled={state.busy || undefined}
        >
          {state.busy ? 'Saving…' : 'Save to folder'}
        </Button>
      </div>
    </form>
  );
}

function SavedStep({
  model,
  state,
  onOpenFolder,
  onClose,
}: {
  model: AddSourceFlow;
  state: Extract<AddSourceState, { step: 'saved' }>;
  onOpenFolder: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [folderError, setFolderError] = useState<string | null>(null);
  return (
    <div style={STACK}>
      <p tabIndex={-1} data-step-focus style={WRAP}>
        Saved <span className="wv-mono">{state.file}</span> in your folder. The source <strong>{state.id}</strong> is
        listed under Definitions, {state.enabled ? 'switched on' : 'disabled'}.
      </p>
      {state.enabled ? (
        <p role="alert" className="wv-form-error" style={WRAP}>
          It is on because an earlier source with the id {state.id} was left enabled. Switch it off under Definitions if
          the file is not finished.
        </p>
      ) : null}
      {state.todo.length ? (
        <DraftList
          title="Before you switch it on, edit the file to"
          items={state.todo}
          className="wv-credential__state"
        />
      ) : null}
      <div style={ROW}>
        <Button icon="external" onClick={() => void onOpenFolder().then(setFolderError)}>
          Open folder
        </Button>
        <Button onClick={() => model.startOver()}>Add another</Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
      {folderError ? (
        <p role="alert" className="wv-form-error" style={WRAP}>
          {folderError}
        </p>
      ) : null}
    </div>
  );
}

function DraftList({
  title,
  items,
  className,
  note,
}: {
  title: string;
  items: readonly string[];
  className: string;
  note?: string | undefined;
}) {
  const id = useId();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      <h3 id={id} className="wv-caps">
        {title}
      </h3>
      <ul aria-labelledby={id} style={{ margin: 0, paddingLeft: '1.25em', minWidth: 0 }}>
        {items.map((item, i) => (
          <li key={i} className={className} style={WRAP}>
            {item}
          </li>
        ))}
      </ul>
      {note ? (
        <p className="wv-credential__state" style={WRAP}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
