import type {
  DefinitionDraft,
  DefinitionFileEntry,
  DefinitionsListing,
  DefinitionsReload,
  IpcError,
  RequestChannel,
  RequestOf,
  ResponseOf,
} from '@worldview/ipc-contract';
import type { DefinitionsClient } from './sources-definitions-model.js';

/**
 * A scripted stand-in for the `sources.definitions.*` side of the client, for the Sources
 * panel's tests only. Each channel answers from a handler the test sets; `hold()` keeps
 * the next answer on a channel back until the test releases it, so ordering can be tested.
 */
export class DefinitionsTestClient implements DefinitionsClient {
  readonly calls: Array<{ channel: string; request: unknown }> = [];
  private handlers = new Map<string, (request: unknown) => unknown>();
  private held = new Map<string, Array<() => void>>();
  private holding = new Set<string>();

  on<C extends RequestChannel>(channel: C, handler: (request: RequestOf<C>) => ResponseOf<C>): this {
    this.handlers.set(channel, handler as (request: unknown) => unknown);
    return this;
  }

  /** The next request on `channel` waits until `release(channel)`. */
  hold(channel: RequestChannel): void {
    this.holding.add(channel);
  }

  /** Lets the oldest held request on `channel` answer. */
  release(channel: RequestChannel): void {
    const next = this.held.get(channel)?.shift();
    if (!next) throw new Error(`nothing held on ${channel}`);
    next();
  }

  count(channel: RequestChannel): number {
    return this.calls.filter((c) => c.channel === channel).length;
  }

  request<C extends RequestChannel>(channel: C, request: RequestOf<C>): Promise<ResponseOf<C>> {
    this.calls.push({ channel, request });
    const answer = () => {
      const handler = this.handlers.get(channel);
      if (!handler) throw ipcError('INTERNAL', `no handler for ${channel}`, channel);
      return handler(request) as ResponseOf<C>;
    };
    if (!this.holding.has(channel)) return Promise.resolve().then(answer);
    this.holding.delete(channel);
    return new Promise<ResponseOf<C>>((resolve, reject) => {
      const queue = this.held.get(channel) ?? [];
      queue.push(() => {
        try {
          resolve(answer());
        } catch (err) {
          reject(err);
        }
      });
      this.held.set(channel, queue);
    });
  }
}

export function ipcError(code: IpcError['code'], message: string, channel = 'sources.definitions'): IpcError {
  return { code, message, channel };
}

export function file(name: string, extra: Partial<DefinitionFileEntry> = {}): DefinitionFileEntry {
  return { file: name, enabled: false, bundled: name.startsWith('bundled/'), problems: [], warnings: [], ...extra };
}

export function listing(folder: string | null, files: DefinitionFileEntry[]): DefinitionsListing {
  return { folder, files };
}

export function reloaded(
  base: DefinitionsListing,
  change: Partial<Pick<DefinitionsReload, 'added' | 'removed' | 'restarted'>> = {},
): DefinitionsReload {
  return { ...base, added: [], removed: [], restarted: [], ...change };
}

export function draftOf(extra: Partial<DefinitionDraft> = {}): DefinitionDraft {
  return {
    definition: { id: 'example-org-stations', connector: 'geojson', review: 'user-configured', enabled: false },
    connector: 'geojson',
    notes: ['features carry an id; it is the external id'],
    todo: ['attribution.text and termsUrl: name the licence and the rights holder before this source is shown'],
    validation: { ok: true, errors: [], warnings: [] },
    ...extra,
  };
}

/** Lets every queued promise callback run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
