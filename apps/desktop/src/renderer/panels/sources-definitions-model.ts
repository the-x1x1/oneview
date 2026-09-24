import {
  isIpcError,
  type DefinitionDraft,
  type DefinitionFileEntry,
  type DefinitionsListing,
  type DefinitionsReload,
  type WorldClient,
} from '@worldview/ipc-contract';
import type { SourceHealthEntry } from '@worldview/source-health';

/**
 * State and requests behind the Sources panel's Definitions section and the Add-source
 * dialog (ADR-013 amendment #9, `sources.definitions.*`). Kept apart from the components so
 * the flows are tested with a mock client and no DOM; the components only subscribe.
 */

/** The part of the client these flows use; tests pass a mock. */
export type DefinitionsClient = Pick<WorldClient, 'request'>;

/** The runtime's own rule for a saved definition's id (`support/definitions.ts`). */
export const DEFINITION_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** What an operator is shown for a failed request: the runtime's message, with what to do about it. */
export function describeDefinitionError(err: unknown): string {
  if (isIpcError(err)) {
    switch (err.code) {
      case 'NOT_FOUND':
        return `${err.message}. The folder changed since it was listed; reload it.`;
      case 'DENIED':
        return `${err.message}. Only https addresses on public hosts can be drafted.`;
      case 'UNAVAILABLE':
      case 'INVALID_REQUEST':
        return err.message;
      default:
        return `${err.message} (${err.code})`;
    }
  }
  if (err instanceof Error && err.message) return err.message.slice(0, 200);
  return 'The request failed.';
}

// ---- rows ---------------------------------------------------------------------------

export type DefinitionState = 'enabled' | 'disabled' | 'rejected';

export interface DefinitionRow {
  file: string;
  /** The file name without the `bundled/` prefix, for display. */
  name: string;
  id?: string;
  connector?: string;
  bundled: boolean;
  state: DefinitionState;
  /** Only a file that loaded has a source to switch. */
  switchable: boolean;
  problems: string[];
  warnings: string[];
}

/**
 * Rows for the Definitions list: the operator's own files first, then the shipped ones,
 * each group by name. Whether a source is enabled is read from the live source list when
 * it has the source (it changes from the source's own row too) and from the listing
 * otherwise.
 */
export function definitionRows(
  listing: DefinitionsListing,
  entries: readonly Pick<SourceHealthEntry, 'providerId' | 'enabled'>[] = [],
): DefinitionRow[] {
  const live = new Map(entries.map((e) => [e.providerId, e.enabled]));
  const rows = listing.files.map((f: DefinitionFileEntry): DefinitionRow => {
    const loaded = f.id !== undefined && f.problems.length === 0;
    const enabled = loaded ? (live.get(f.id!) ?? f.enabled) : false;
    return {
      file: f.file,
      name: f.bundled ? f.file.replace(/^bundled\//, '') : f.file,
      ...(f.id !== undefined ? { id: f.id } : {}),
      ...(f.connector !== undefined ? { connector: f.connector } : {}),
      bundled: f.bundled,
      state: loaded ? (enabled ? 'enabled' : 'disabled') : 'rejected',
      switchable: loaded,
      problems: f.problems,
      warnings: f.warnings,
    };
  });
  return rows.sort((a, b) => Number(a.bundled) - Number(b.bundled) || a.name.localeCompare(b.name));
}

/** "4 files · 3 loaded · 1 rejected" — the counts the section header shows. */
export function definitionsSummary(rows: readonly DefinitionRow[]): string {
  if (rows.length === 0) return 'no definition files';
  const rejected = rows.filter((r) => r.state === 'rejected').length;
  const parts = [`${rows.length} ${rows.length === 1 ? 'file' : 'files'}`, `${rows.length - rejected} loaded`];
  if (rejected) parts.push(`${rejected} rejected`);
  return parts.join(' · ');
}

/** One line for what a reload did, naming the sources it started, stopped or restarted. */
export function reloadSummary(r: DefinitionsReload): string {
  const parts: string[] = [];
  if (r.added.length) parts.push(`started ${r.added.join(', ')}`);
  if (r.restarted.length) parts.push(`restarted ${r.restarted.join(', ')}`);
  if (r.removed.length) parts.push(`stopped ${r.removed.join(', ')}`);
  const rejected = r.files.filter((f) => f.problems.length > 0).length;
  const head = parts.length ? `Reloaded: ${parts.join('; ')}.` : 'Reloaded: no source changed.';
  return rejected ? `${head} ${rejected} ${rejected === 1 ? 'file was' : 'files were'} rejected.` : head;
}

// ---- a small observable -------------------------------------------------------------

type Listener = () => void;

class Observable<S> {
  private listeners = new Set<Listener>();
  constructor(protected state: S) {}
  getState = (): S => this.state;
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected set(next: S): void {
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
}

// ---- Definitions section ------------------------------------------------------------

export interface DefinitionsState {
  /** `loading` until the first listing arrives; `failed` when it never did. */
  status: 'loading' | 'ready' | 'failed';
  listing: DefinitionsListing | null;
  /** A folder-wide request in flight (the Reload and Open folder buttons wait on it). */
  busy: 'reload' | 'open' | null;
  /** Files whose enabled switch is waiting for the runtime. */
  pending: string[];
  error: string | null;
  /** The outcome of the last action, announced politely. */
  notice: string | null;
}

/**
 * The Definitions section's requests. Every listing that comes back is stamped with the
 * order its request was sent in, and an older answer never replaces a newer one — a reload
 * and a switch can be in flight together. When two changes did overlap, the listing is
 * read once more after the last of them, so what is shown is what the runtime ended with.
 */
export class DefinitionsController extends Observable<DefinitionsState> {
  private sent = 0;
  private applied = 0;
  private inflight = 0;
  private overlapped = false;

  constructor(private readonly client: DefinitionsClient) {
    super({ status: 'loading', listing: null, busy: null, pending: [], error: null, notice: null });
  }

  /** Runs one change; after the last of several overlapping ones, lists the folder again. */
  private async change(fn: () => Promise<void>): Promise<void> {
    if (this.inflight > 0) this.overlapped = true;
    this.inflight++;
    try {
      await fn();
    } finally {
      this.inflight--;
      if (this.inflight === 0 && this.overlapped) {
        this.overlapped = false;
        void this.load();
      }
    }
  }

  private accept(seq: number, listing: DefinitionsListing): void {
    if (seq < this.applied) return;
    this.applied = seq;
    this.set({ ...this.state, status: 'ready', listing });
  }

  async load(): Promise<void> {
    const seq = ++this.sent;
    try {
      this.accept(seq, await this.client.request('sources.definitions.list', undefined));
    } catch (err) {
      if (this.state.listing) this.set({ ...this.state, error: describeDefinitionError(err) });
      else this.set({ ...this.state, status: 'failed', error: describeDefinitionError(err) });
    }
  }

  reload(): Promise<void> {
    if (this.state.busy) return Promise.resolve();
    const seq = ++this.sent;
    this.set({ ...this.state, busy: 'reload', error: null, notice: null });
    return this.change(async () => {
      try {
        const r = await this.client.request('sources.definitions.reload', undefined);
        this.accept(seq, r);
        this.set({ ...this.state, busy: null, notice: reloadSummary(r) });
      } catch (err) {
        this.set({ ...this.state, busy: null, error: describeDefinitionError(err) });
      }
    });
  }

  setEnabled(file: string, enabled: boolean): Promise<void> {
    if (this.state.pending.includes(file)) return Promise.resolve();
    const seq = ++this.sent;
    this.set({ ...this.state, pending: [...this.state.pending, file], error: null, notice: null });
    const done = () => this.state.pending.filter((f) => f !== file);
    return this.change(async () => {
      try {
        const listing = await this.client.request('sources.definitions.setEnabled', { file, enabled });
        this.accept(seq, listing);
        this.set({ ...this.state, pending: done(), notice: `${file} ${enabled ? 'enabled' : 'disabled'}.` });
      } catch (err) {
        this.set({ ...this.state, pending: done(), error: describeDefinitionError(err) });
      }
    });
  }

  async openFolder(): Promise<void> {
    if (this.state.busy) return;
    this.set({ ...this.state, busy: 'open', error: null, notice: null });
    try {
      const r = await this.client.request('sources.definitions.openFolder', undefined);
      this.set({
        ...this.state,
        busy: null,
        ...(r.opened
          ? { notice: r.folder ? `Opened ${r.folder}.` : 'Opened the folder.' }
          : { error: r.folder ? `The folder could not be opened: ${r.folder}` : 'This runtime has no folder.' }),
      });
    } catch (err) {
      this.set({ ...this.state, busy: null, error: describeDefinitionError(err) });
    }
  }

  /** A save reloads the folder in the runtime; its listing is the newest there is. */
  applySaved(file: string, listing: DefinitionsReload): void {
    const seq = ++this.sent;
    this.accept(seq, listing);
    this.set({ ...this.state, error: null, notice: `Saved ${file}. It is disabled until you switch it on.` });
  }
}

// ---- Add-source dialog --------------------------------------------------------------

/** Checked before anything is sent; the main process applies the full URL policy again. */
export function checkDraftUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return 'Enter the address of a JSON, GeoJSON or CSV sample.';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'That is not a complete address; it should start with https://.';
  }
  if (url.protocol !== 'https:') return 'Only https addresses can be drafted.';
  if (url.username || url.password)
    return 'Leave credentials out of the address; the definition names a secret instead.';
  return null;
}

/** Checked as the operator types; the runtime checks it again when the file is written. */
export function checkDefinitionId(id: string, taken: ReadonlySet<string>): string | null {
  if (!DEFINITION_ID.test(id))
    return 'Use 2–63 characters: lower-case letters, digits and hyphens, not starting with a hyphen.';
  if (taken.has(id)) return `${id} is already used by another source.`;
  return null;
}

export type AddSourceState =
  | { step: 'url'; url: string; busy: boolean; error: string | null }
  | { step: 'draft'; url: string; draft: DefinitionDraft; id: string; busy: boolean; error: string | null }
  | { step: 'saved'; file: string; id: string; todo: string[] };

/** The id a draft proposes, or '' when it proposes none. */
function draftId(draft: DefinitionDraft): string {
  const id = draft.definition['id'];
  return typeof id === 'string' ? id : '';
}

/**
 * URL → draft → validation → save. Nothing is written until Save; what is written is the
 * draft the runtime made, under the id shown, disabled. A result that arrives after the
 * dialog was closed, or after the operator started over, is dropped.
 */
export class AddSourceFlow extends Observable<AddSourceState> {
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly client: DefinitionsClient,
    private readonly takenIds: () => ReadonlySet<string> = () => new Set(),
    private readonly onSaved: (file: string, listing: DefinitionsReload) => void = () => undefined,
  ) {
    super({ step: 'url', url: '', busy: false, error: null });
  }

  /** The dialog is showing (again): results are applied. */
  attach(): void {
    this.disposed = false;
  }

  /** The dialog closed: a draft still in flight is dropped; a save still lands in the list. */
  dispose(): void {
    this.disposed = true;
    this.generation++;
  }

  setUrl(url: string): void {
    if (this.state.step !== 'url' || this.state.busy) return;
    this.set({ ...this.state, url, error: null });
  }

  setId(id: string): void {
    if (this.state.step !== 'draft' || this.state.busy) return;
    this.set({ ...this.state, id: id.trim().toLowerCase(), error: null });
  }

  /** Back to the address, keeping it, so another sample can be drafted. */
  startOver(): void {
    if (this.state.step === 'draft' && this.state.busy) return;
    this.generation++;
    const url = this.state.step === 'saved' ? '' : this.state.url;
    this.set({ step: 'url', url, busy: false, error: null });
  }

  idProblem(): string | null {
    return this.state.step === 'draft' ? checkDefinitionId(this.state.id, this.takenIds()) : null;
  }

  canSave(): boolean {
    const s = this.state;
    return s.step === 'draft' && !s.busy && s.draft.validation.ok && this.idProblem() === null;
  }

  async draft(): Promise<void> {
    const s = this.state;
    if (s.step !== 'url' || s.busy) return;
    const bad = checkDraftUrl(s.url);
    if (bad) {
      this.set({ ...s, error: bad });
      return;
    }
    const url = s.url.trim();
    const gen = ++this.generation;
    this.set({ step: 'url', url, busy: true, error: null });
    try {
      const draft = await this.client.request('sources.definitions.draft', { url });
      if (gen !== this.generation || this.disposed) return;
      this.set({ step: 'draft', url, draft, id: draftId(draft), busy: false, error: null });
    } catch (err) {
      if (gen !== this.generation || this.disposed) return;
      this.set({ step: 'url', url, busy: false, error: describeDefinitionError(err) });
    }
  }

  async save(): Promise<void> {
    const s = this.state;
    if (s.step !== 'draft' || s.busy) return;
    if (!s.draft.validation.ok) {
      this.set({ ...s, error: 'This draft does not validate, so it cannot be saved.' });
      return;
    }
    const idError = this.idProblem();
    if (idError) {
      this.set({ ...s, error: idError });
      return;
    }
    const gen = ++this.generation;
    this.set({ ...s, busy: true, error: null });
    try {
      const r = await this.client.request('sources.definitions.save', { id: s.id, definition: s.draft.definition });
      if (this.disposed) {
        // The file is written whether or not the dialog is still open; the list must show it.
        this.onSaved(r.file, r.listing);
        return;
      }
      if (gen !== this.generation) return;
      this.onSaved(r.file, r.listing);
      this.set({ step: 'saved', file: r.file, id: s.id, todo: s.draft.todo });
    } catch (err) {
      if (gen !== this.generation || this.disposed) return;
      this.set({ ...s, busy: false, error: describeDefinitionError(err) });
    }
  }
}
