import { systemClock, type Clock } from '@worldview/world-model';
import { TypedEmitter, silentLogger, type Logger } from '@worldview/core';
import type { ConnectionSnapshot, ConnectionState } from '@worldview/source-health';

/**
 * ConnectionMonitor — the application's single answer to "are we online?".
 *
 * Inputs (all injected, nothing here touches the network):
 *   - the OS/network signal (`navigator.onLine`, Electron's net module, …)
 *   - an optional reachability probe (a tiny HEAD request implemented by the host)
 *   - the SourceHealthRegistry snapshot (how many remote sources are actually live)
 *
 * Output: CONNECTED / DEGRADED / OFFLINE with hysteresis — a probe-driven change
 * needs `hysteresis` consecutive agreeing evaluations (default 2) so a single
 * failed probe or one flapping source never toggles the indicator. An OS "offline"
 * signal is authoritative and applies immediately.
 */
export interface NetworkSignal {
  isOnline(): boolean;
  /** Optional push source for OS connectivity changes. */
  subscribe?(listener: (online: boolean) => void): () => void;
}

export type ReachabilityProbe = () => Promise<boolean>;

/** Structural subset of SourceHealthRegistry. */
export interface SourceHealthSource {
  connection(): ConnectionSnapshot;
  on?(event: 'connection', listener: (snapshot: ConnectionSnapshot) => void): () => void;
}

export interface Scheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ConnectionMonitorOptions {
  network: NetworkSignal;
  probe?: ReachabilityProbe;
  sourceHealth?: SourceHealthSource;
  clock?: Clock;
  /** Consecutive agreeing evaluations before a probe/source-driven change is committed (default 2). */
  hysteresis?: number;
  /** Interval for `start()` (default 30 s). */
  probeIntervalMs?: number;
  scheduler?: Scheduler;
  logger?: Logger;
}

export interface ConnectionMonitorEvents extends Record<string, unknown> {
  change: ConnectionSnapshot;
}

export class ConnectionMonitor {
  private readonly network: NetworkSignal;
  private readonly probe: ReachabilityProbe | undefined;
  private readonly sourceHealth: SourceHealthSource | undefined;
  private readonly clock: Clock;
  private readonly hysteresis: number;
  private readonly intervalMs: number;
  private readonly scheduler: Scheduler;
  private readonly log: Logger;
  private readonly emitter = new TypedEmitter<ConnectionMonitorEvents>();

  private committed: ConnectionState;
  private candidate: ConnectionState | undefined;
  private candidateCount = 0;
  private lastProbe: boolean | undefined;
  private lastProbeAt: number | undefined;
  private timer: unknown;
  private unsubscribers: Array<() => void> = [];
  private inFlight: Promise<ConnectionSnapshot> | undefined;

  constructor(opts: ConnectionMonitorOptions) {
    this.network = opts.network;
    this.probe = opts.probe;
    this.sourceHealth = opts.sourceHealth;
    this.clock = opts.clock ?? systemClock;
    this.hysteresis = Math.max(1, Math.floor(opts.hysteresis ?? 2));
    this.intervalMs = opts.probeIntervalMs ?? 30_000;
    this.scheduler = opts.scheduler ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
    this.log = opts.logger ?? silentLogger;
    this.committed = this.observe(undefined);
  }

  state(): ConnectionState {
    return this.committed;
  }

  snapshot(): ConnectionSnapshot {
    const base = this.sourceHealth?.connection();
    return {
      state: this.committed,
      networkOnline: this.network.isOnline(),
      remoteLive: base?.remoteLive ?? 0,
      remoteTotal: base?.remoteTotal ?? 0,
      localLive: base?.localLive ?? 0,
      at: new Date(this.clock.now()).toISOString(),
    };
  }

  on<K extends keyof ConnectionMonitorEvents>(
    event: K,
    listener: (payload: ConnectionMonitorEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /** Last probe outcome and when it ran (diagnostics). */
  probeStatus(): { result: boolean | undefined; at: string | undefined } {
    return {
      result: this.lastProbe,
      at: this.lastProbeAt === undefined ? undefined : new Date(this.lastProbeAt).toISOString(),
    };
  }

  /** Subscribe to the injected push sources and evaluate every `probeIntervalMs`. */
  start(): void {
    if (this.timer !== undefined) return;
    if (this.network.subscribe)
      this.unsubscribers.push(this.network.subscribe((online) => this.onNetworkSignal(online)));
    if (this.sourceHealth?.on)
      this.unsubscribers.push(
        this.sourceHealth.on('connection', () => {
          this.evaluate(this.lastProbe);
        }),
      );
    this.timer = this.scheduler.setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      this.scheduler.clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }

  /**
   * One evaluation: read the OS flag, run the probe when the OS says online, fold in
   * source health, apply hysteresis. Safe to call at any time; concurrent calls share
   * one probe.
   */
  tick(): Promise<ConnectionSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Feed an OS connectivity signal directly (equivalent to the subscription). */
  onNetworkSignal(online: boolean): void {
    if (!online) {
      this.commit('OFFLINE', 'os-offline');
      return;
    }
    this.evaluate(this.lastProbe);
  }

  private async runTick(): Promise<ConnectionSnapshot> {
    if (!this.network.isOnline()) {
      this.commit('OFFLINE', 'os-offline');
      return this.snapshot();
    }
    if (this.probe) {
      let result: boolean;
      try {
        result = await this.probe();
      } catch {
        result = false;
      }
      this.lastProbe = result;
      this.lastProbeAt = this.clock.now();
    }
    this.evaluate(this.lastProbe);
    return this.snapshot();
  }

  /** Apply hysteresis to a freshly observed state. */
  private evaluate(probeResult: boolean | undefined): void {
    const observed = this.observe(probeResult);
    if (observed === this.committed) {
      this.candidate = undefined;
      this.candidateCount = 0;
      return;
    }
    if (observed === this.candidate) this.candidateCount++;
    else {
      this.candidate = observed;
      this.candidateCount = 1;
    }
    if (this.candidateCount >= this.hysteresis) this.commit(observed, 'evaluated');
  }

  private observe(probeResult: boolean | undefined): ConnectionState {
    if (!this.network.isOnline()) return 'OFFLINE';
    if (probeResult === false) return 'OFFLINE';
    const health = this.sourceHealth?.connection();
    if (!health) return 'CONNECTED';
    if (health.remoteTotal === 0) return 'CONNECTED';
    if (health.remoteLive === 0) return probeResult === true ? 'DEGRADED' : 'OFFLINE';
    return health.remoteLive < health.remoteTotal ? 'DEGRADED' : 'CONNECTED';
  }

  private commit(state: ConnectionState, reason: string): void {
    this.candidate = undefined;
    this.candidateCount = 0;
    if (state === this.committed) return;
    const from = this.committed;
    this.committed = state;
    this.log.info('connection state changed', { from, to: state, reason });
    this.emitter.emit('change', this.snapshot());
  }
}
