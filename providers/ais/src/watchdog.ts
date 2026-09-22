/**
 * Pure liveness / reconnect state machine for the AISStream socket.
 * Adapted from gods-eye-view src/data/aisWatchdog.js (MIT), reduced to one silence budget.
 *
 * Liveness is judged by DATA, not by socket state: AISStream can complete the handshake and
 * deliver nothing. Only a decoded AIS envelope counts as a message. Failures are classified —
 * transport faults walk the backoff ladder, an auth rejection is terminal until the credential
 * changes, a rate limit honours the server's delay. The machine owns no sockets or timers; it
 * returns actions for the provider to perform, so the whole policy is testable offline.
 */
export interface WatchdogOptions {
  /** Silence (no valid AIS frame) after which the socket is recycled. */
  silenceMs: number;
  /** Backoff ladder for transport failures; its length is the attempt budget before 'down'. */
  backoffMs: readonly number[];
  /** Slow retry cadence once the ladder is exhausted. */
  downRetryMs: number;
  /** Probe cadence while the key is being rejected. */
  authProbeMs: number;
}

export const WATCHDOG_DEFAULTS: WatchdogOptions = Object.freeze({
  silenceMs: 90_000,
  backoffMs: Object.freeze([5_000, 15_000, 60_000, 300_000]),
  downRetryMs: 900_000,
  authProbeMs: 3_600_000,
});

export type WatchdogStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'down' | 'auth-failed';
export type FailureKind = 'transport' | 'auth' | 'rate-limit';

export type WatchdogAction =
  { type: 'connect'; generation: number } | { type: 'terminate'; generation: number; reason: string };

export interface WatchdogSnapshot {
  status: WatchdogStatus;
  error: string | undefined;
  lastMessageAt: number | undefined;
  silentForMs: number | undefined;
  attempt: number;
  nextAttemptAt: number | undefined;
  generation: number;
}

const QUIET_TERMINAL = new Set<WatchdogStatus>(['down', 'auth-failed']);

export class AisWatchdog {
  private readonly opts: WatchdogOptions;
  private status: WatchdogStatus = 'idle';
  private generation: number;
  private owned: number | undefined;
  private silenceSince = 0;
  private lastMessageAt: number | undefined;
  private attempt = 0;
  private nextAttemptAt = 0;
  private error: string | undefined;

  constructor(opts: Partial<WatchdogOptions> = {}, startGeneration = 0) {
    this.opts = { ...WATCHDOG_DEFAULTS, ...opts };
    this.generation = Math.max(0, startGeneration);
  }

  get currentStatus(): WatchdogStatus {
    return this.status;
  }
  get ownedGeneration(): number | undefined {
    return this.owned;
  }
  get silenceMs(): number {
    return this.opts.silenceMs;
  }

  ownsGeneration(generation: number): boolean {
    return this.owned !== undefined && generation === this.owned;
  }

  /** Advance time. Returns actions in order: at most one terminate followed by at most one connect. */
  tick(now: number): WatchdogAction[] {
    if (this.owned !== undefined) {
      if (this.status === 'auth-failed') {
        if (now - this.silenceSince >= this.opts.authProbeMs) {
          const a = this.terminateOwned('auth-probe-expired');
          this.scheduleRetry('auth', now);
          return a;
        }
        return [];
      }
      const silentFor = now - this.silenceSince;
      if (silentFor >= this.opts.silenceMs) {
        this.error = `no AIS data for ${Math.round(silentFor / 1000)} s`;
        const actions = this.terminateOwned('silent');
        this.scheduleRetry('transport', now);
        return actions;
      }
      return [];
    }
    if (now < this.nextAttemptAt) return [];
    this.generation += 1;
    this.owned = this.generation;
    this.silenceSince = now; // budget starts when the socket is commissioned, not when it opens
    if (!QUIET_TERMINAL.has(this.status)) this.status = 'connecting';
    return [{ type: 'connect', generation: this.generation }];
  }

  /** Handshake completed. Not liveness; an orphan is told to hang up. */
  onOpen(generation: number): WatchdogAction[] {
    if (!this.ownsGeneration(generation)) return [{ type: 'terminate', generation, reason: 'orphan' }];
    return [];
  }

  /** A VALID AIS envelope arrived — the only event that proves the feed works. */
  onMessage(generation: number, now: number): WatchdogAction[] {
    if (!this.ownsGeneration(generation)) return [{ type: 'terminate', generation, reason: 'orphan' }];
    this.silenceSince = now;
    this.lastMessageAt = now;
    this.attempt = 0;
    this.error = undefined;
    this.status = 'live';
    return [];
  }

  /** The socket closed on its own. */
  onClose(generation: number, now: number, reason?: string): WatchdogAction[] {
    if (!this.ownsGeneration(generation)) return [];
    this.owned = undefined;
    if (!this.error) this.error = reason ? `socket closed: ${reason}` : 'socket closed';
    this.scheduleRetry('transport', now);
    return [];
  }

  /** A classified failure: terminate now and schedule by class. */
  onFailure(
    generation: number,
    now: number,
    detail: { kind?: FailureKind; message?: string; retryAfterMs?: number } = {},
  ): WatchdogAction[] {
    if (!this.ownsGeneration(generation)) return [];
    const kind = detail.kind ?? 'transport';
    if (!(this.status === 'auth-failed' && kind !== 'auth')) this.error = detail.message ?? defaultMessage(kind);
    const actions = this.terminateOwned(kind);
    this.scheduleRetry(kind, now, detail.retryAfterMs);
    return actions;
  }

  /** Credential changed: leave auth-failed and allow an immediate attempt. */
  onCredentialChange(now: number): WatchdogAction[] {
    const actions = this.terminateOwned('key-rotated');
    this.status = 'idle';
    this.error = undefined;
    this.attempt = 0;
    this.nextAttemptAt = now;
    return actions;
  }

  /** Tear down; the generation counter is never reset so late handlers stay orphans. */
  reset(): WatchdogAction[] {
    const actions = this.terminateOwned('dispose');
    this.status = 'idle';
    this.attempt = 0;
    this.nextAttemptAt = 0;
    this.silenceSince = 0;
    this.error = undefined;
    return actions;
  }

  snapshot(now: number): WatchdogSnapshot {
    return {
      status: this.status,
      error: this.error,
      lastMessageAt: this.lastMessageAt,
      silentForMs: this.owned !== undefined ? Math.max(0, now - this.silenceSince) : undefined,
      attempt: this.attempt,
      nextAttemptAt: this.owned === undefined && this.status !== 'idle' ? this.nextAttemptAt : undefined,
      generation: this.generation,
    };
  }

  private terminateOwned(reason: string): WatchdogAction[] {
    if (this.owned === undefined) return [];
    const generation = this.owned;
    this.owned = undefined;
    return [{ type: 'terminate', generation, reason }];
  }

  private scheduleRetry(kind: FailureKind, now: number, retryAfterMs?: number): void {
    // While the key is refused, no other outcome may return the feed to the fast ladder.
    const effective: FailureKind = this.status === 'auth-failed' && kind !== 'auth' ? 'auth' : kind;
    this.attempt += 1;
    const ladder = this.opts.backoffMs;
    if (effective === 'auth') {
      this.status = 'auth-failed';
      this.nextAttemptAt = now + this.opts.authProbeMs;
      return;
    }
    if (effective === 'rate-limit') {
      this.attempt = Math.max(this.attempt, ladder.length);
      const wait =
        retryAfterMs && retryAfterMs > 0 ? retryAfterMs : (ladder[ladder.length - 1] ?? this.opts.downRetryMs);
      const exhausted = this.attempt > ladder.length;
      this.status = exhausted ? 'down' : 'reconnecting';
      this.nextAttemptAt = now + (exhausted ? Math.max(wait, this.opts.downRetryMs) : wait);
      return;
    }
    if (this.attempt > ladder.length) {
      this.status = 'down';
      this.nextAttemptAt = now + this.opts.downRetryMs;
      return;
    }
    this.status = 'reconnecting';
    this.nextAttemptAt = now + (ladder[this.attempt - 1] ?? this.opts.downRetryMs);
  }
}

function defaultMessage(kind: FailureKind): string {
  switch (kind) {
    case 'auth':
      return 'AISStream rejected the API key';
    case 'rate-limit':
      return 'AISStream rate-limited this key';
    default:
      return 'AISStream websocket error';
  }
}
