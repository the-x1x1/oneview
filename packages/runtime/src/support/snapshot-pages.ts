import { randomBytes } from 'node:crypto';
import type { WorldObject } from '@worldview/world-model';

interface Session {
  token: string;
  objects: WorldObject[];
  offset: number;
  pageSize: number;
  expiresAt: number;
}

/**
 * The rest of a paged `world.subscribe` snapshot, per client, until the client has fetched
 * it (`world.subscribe.more`).
 *
 * One session per client: a new subscription replaces the old one, whose token then answers
 * NOT_FOUND — the page asked for something else in the meantime, and finishing the old
 * snapshot would only overwrite the new one. The objects are the ones taken when the
 * subscription was made; changes since reach the client as deltas, which the page lets win
 * over a later page (store/reducer.ts). A session nobody asks for is dropped after `ttlMs`.
 */
export class SnapshotPages {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = 60_000,
    private readonly newToken: () => string = () => randomBytes(12).toString('hex'),
  ) {}

  /** The first page; the rest kept for `next` when there is more than one page. */
  start(
    clientId: string,
    objects: WorldObject[],
    pageSize: number | undefined,
  ): { first: WorldObject[]; more?: { token: string; remaining: number } } {
    this.sessions.delete(clientId);
    this.sweep();
    if (!pageSize || objects.length <= pageSize) return { first: objects };
    const token = this.newToken();
    this.sessions.set(clientId, {
      token,
      objects,
      offset: pageSize,
      pageSize,
      expiresAt: this.now() + this.ttlMs,
    });
    return { first: objects.slice(0, pageSize), more: { token, remaining: objects.length - pageSize } };
  }

  /** The next page, or undefined when `token` is not this client's current session. */
  next(clientId: string, token: string): { page: WorldObject[]; done: boolean } | undefined {
    const session = this.sessions.get(clientId);
    if (!session || session.token !== token || session.expiresAt < this.now()) {
      if (session && session.expiresAt < this.now()) this.sessions.delete(clientId);
      return undefined;
    }
    const page = session.objects.slice(session.offset, session.offset + session.pageSize);
    session.offset += page.length;
    session.expiresAt = this.now() + this.ttlMs;
    const done = session.offset >= session.objects.length;
    if (done) this.sessions.delete(clientId);
    return { page, done };
  }

  /** Sessions held (diagnostics, tests). */
  get size(): number {
    return this.sessions.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [client, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(client);
  }
}
