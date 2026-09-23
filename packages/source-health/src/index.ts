import type { ProviderHealth, ProviderStatus, ProviderManifest } from '@worldview/provider-sdk';
import type { Clock } from '@worldview/world-model';
import { systemClock } from '@worldview/world-model';

/**
 * @worldview/source-health — one registry of every source's health plus the
 * application-level connection state (CONNECTED / DEGRADED / OFFLINE).
 *
 * The registry is the single truth the Source Health panel, diagnostics, the
 * event engine (source-status-change events) and the offline indicator read from.
 */
export type ConnectionState = 'CONNECTED' | 'DEGRADED' | 'OFFLINE';

export type SourceLocality = 'remote' | 'local' | 'bundled';

export interface SourceHealthEntry {
  providerId: string;
  name: string;
  categories: string[];
  locality: SourceLocality;
  enabled: boolean;
  health: ProviderHealth;
  /** Last N status transitions, newest first. */
  transitions: Array<{ from: ProviderStatus; to: ProviderStatus; at: string }>;
  /** Manifest metadata the panel shows: attribution, terms, refresh interval, data policy summary. */
  meta: {
    attribution: string;
    termsUrl?: string;
    refreshIntervalMs: number;
    cacheAllowed: boolean;
    credentialsRequired: string[];
    commercialReview: ProviderManifest['commercialReview'];
  };
}

export interface ConnectionSnapshot {
  state: ConnectionState;
  /** Whether the OS/network layer reports connectivity (from the desktop shell). */
  networkOnline: boolean;
  remoteLive: number;
  remoteTotal: number;
  localLive: number;
  at: string;
}

export interface SourceHealthEvents {
  change: { providerId: string; from: ProviderStatus; to: ProviderStatus; entry: SourceHealthEntry };
  connection: ConnectionSnapshot;
}

type Listener<K extends keyof SourceHealthEvents> = (payload: SourceHealthEvents[K]) => void;

const LIVE_LIKE: ReadonlySet<ProviderStatus> = new Set(['LIVE', 'DEGRADED', 'STALE', 'RATE_LIMITED']);

export class SourceHealthRegistry {
  private readonly entries = new Map<string, SourceHealthEntry>();
  private readonly listeners: { change: Set<Listener<'change'>>; connection: Set<Listener<'connection'>> } = {
    change: new Set(),
    connection: new Set(),
  };
  private networkOnline = true;
  private lastConnection: ConnectionState | undefined;

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly maxTransitions = 20,
  ) {}

  register(manifest: ProviderManifest, opts: { enabled: boolean; locality?: SourceLocality }): SourceHealthEntry {
    const locality =
      opts.locality ??
      (manifest.transport === 'local-process' || manifest.transport === 'hardware'
        ? 'local'
        : manifest.transport === 'filesystem'
          ? 'bundled'
          : 'remote');
    const entry: SourceHealthEntry = {
      providerId: manifest.id,
      name: manifest.name,
      categories: [...manifest.categories],
      locality,
      enabled: opts.enabled,
      health: {
        providerId: manifest.id,
        status: opts.enabled ? 'STARTING' : 'DISABLED',
        errorRate: 0,
        rateLimitState: { limited: false },
        credentialState: manifest.credentials.some((c) => c.required) ? 'missing' : 'not-required',
      },
      transitions: [],
      meta: {
        attribution: manifest.attribution.text,
        ...(manifest.dataPolicy.termsUrl ? { termsUrl: manifest.dataPolicy.termsUrl } : {}),
        refreshIntervalMs: manifest.refreshPolicy.intervalMs,
        cacheAllowed: manifest.dataPolicy.cacheAllowed,
        credentialsRequired: manifest.credentials.filter((c) => c.required).map((c) => c.key),
        commercialReview: manifest.commercialReview,
      },
    };
    this.entries.set(manifest.id, entry);
    this.recomputeConnection();
    return entry;
  }

  unregister(providerId: string): void {
    this.entries.delete(providerId);
    this.recomputeConnection();
  }

  update(health: ProviderHealth): void {
    const entry = this.entries.get(health.providerId);
    if (!entry) return;
    const from = entry.health.status;
    entry.health = health;
    if (from !== health.status) {
      entry.transitions.unshift({ from, to: health.status, at: new Date(this.clock.now()).toISOString() });
      if (entry.transitions.length > this.maxTransitions) entry.transitions.length = this.maxTransitions;
      for (const l of [...this.listeners.change]) l({ providerId: entry.providerId, from, to: health.status, entry });
      this.recomputeConnection();
    }
  }

  setEnabled(providerId: string, enabled: boolean): void {
    const entry = this.entries.get(providerId);
    if (!entry) return;
    entry.enabled = enabled;
    if (!enabled) this.update({ ...entry.health, status: 'DISABLED' });
    else if (entry.health.status === 'DISABLED') this.update({ ...entry.health, status: 'STARTING' });
  }

  setNetworkOnline(online: boolean): void {
    if (this.networkOnline === online) return;
    this.networkOnline = online;
    this.recomputeConnection(true);
  }

  get(providerId: string): SourceHealthEntry | undefined {
    return this.entries.get(providerId);
  }
  list(): SourceHealthEntry[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  connection(): ConnectionSnapshot {
    let remoteLive = 0,
      remoteTotal = 0,
      localLive = 0;
    for (const e of this.entries.values()) {
      if (!e.enabled) continue;
      if (e.locality === 'remote') {
        remoteTotal++;
        if (LIVE_LIKE.has(e.health.status)) remoteLive++;
      } else if (LIVE_LIKE.has(e.health.status)) localLive++;
    }
    let state: ConnectionState;
    if (!this.networkOnline) state = 'OFFLINE';
    else if (remoteTotal === 0) state = 'CONNECTED';
    else if (remoteLive === 0) state = 'OFFLINE';
    else if (remoteLive < remoteTotal) state = 'DEGRADED';
    else state = 'CONNECTED';
    return {
      state,
      networkOnline: this.networkOnline,
      remoteLive,
      remoteTotal,
      localLive,
      at: new Date(this.clock.now()).toISOString(),
    };
  }

  on<K extends keyof SourceHealthEvents>(event: K, listener: Listener<K>): () => void {
    (this.listeners[event] as Set<Listener<K>>).add(listener);
    return () => {
      (this.listeners[event] as Set<Listener<K>>).delete(listener);
    };
  }

  private recomputeConnection(force = false): void {
    const snap = this.connection();
    if (force || snap.state !== this.lastConnection) {
      this.lastConnection = snap.state;
      for (const l of [...this.listeners.connection]) l(snap);
    }
  }
}

/** Presentation helper: short status text for the health table. */
export function describeStatus(status: ProviderStatus): string {
  switch (status) {
    case 'LIVE':
      return 'Live';
    case 'DEGRADED':
      return 'Degraded';
    case 'STALE':
      return 'Stale';
    case 'RATE_LIMITED':
      return 'Rate limited';
    case 'AUTH_REQUIRED':
      return 'Needs a key';
    case 'OFFLINE':
      return 'Offline';
    case 'ERROR':
      return 'Error';
    case 'STARTING':
      return 'Starting';
    case 'DISABLED':
      return 'Disabled';
  }
}
