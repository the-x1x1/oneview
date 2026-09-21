import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation } from '@worldview/world-model';
import { USGS_MANIFEST, normalizeUsgsFeed } from '@worldview/provider-usgs';
import { ProviderError, type ProviderContext, type ProviderHealth, type ProviderManifest, type ProviderQuery, type WorldProvider } from '@worldview/provider-sdk';

/**
 * Demo earthquake provider: the USGS contract fixture, read from disk, normalized by the
 * real USGS normalizer, with every observation marked `provenance.origin: 'recorded'` so
 * the shell labels it RECORDED DATA. It never touches the network and its manifest is
 * the USGS manifest with the transport changed to `filesystem`, so source health reports
 * it as a bundled source rather than a live remote feed.
 */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'usgs', 'normal.geojson');

export const DEMO_EARTHQUAKE_MANIFEST: ProviderManifest = {
  ...USGS_MANIFEST,
  name: 'USGS Earthquakes (recorded demo)',
  description: 'Recorded USGS earthquake fixture replayed by demo mode. No network access.',
  transport: 'filesystem',
  capabilities: { ...USGS_MANIFEST.capabilities, live: false, historical: false, offline: true },
  refreshPolicy: { ...USGS_MANIFEST.refreshPolicy, intervalMs: 60_000, minIntervalMs: 30_000 },
  allowedHosts: [],
};

export class DemoEarthquakeProvider implements WorldProvider {
  readonly manifest: ProviderManifest = DEMO_EARTHQUAKE_MANIFEST;
  private context!: ProviderContext;
  private running = false;
  private lastCount = 0;
  private lastError: ProviderError | undefined;

  constructor(private readonly fixturePath: string = FIXTURE) {}

  async initialize(context: ProviderContext): Promise<void> { this.context = context; }
  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }

  async query(request: ProviderQuery): Promise<Observation[]> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled');
    let text: string;
    try {
      text = await fs.readFile(this.fixturePath, 'utf8');
    } catch (err) {
      this.lastError = new ProviderError('UNSUPPORTED', `demo fixture ${path.basename(this.fixturePath)} is not readable`, { cause: err, retryable: false });
      throw this.lastError;
    }
    const now = this.context.clock.now();
    const result = normalizeUsgsFeed(JSON.parse(text) as unknown, {
      receivedAt: new Date(now).toISOString(),
      hash: (s) => this.context.hash.sha256Hex(s),
      origin: 'recorded',
      sourceRef: `fixtures/usgs/${path.basename(this.fixturePath)}`,
    });
    // Shift the fixture so the newest event sits ten minutes before "now": the data stays
    // recorded (provenance says so) while freshness classes remain meaningful.
    const newest = Math.max(...result.observations.map((o) => Date.parse(o.observedAt)));
    const shift = Number.isFinite(newest) ? now - 10 * 60_000 - newest : 0;
    const shifted = result.observations.map((o) => shiftObservation(o, shift, this.manifest.id));
    this.lastCount = shifted.length;
    this.lastError = undefined;
    return shifted;
  }

  async health(): Promise<ProviderHealth> {
    const health: ProviderHealth = {
      providerId: this.manifest.id,
      status: !this.running ? 'STARTING' : this.lastError ? 'ERROR' : this.lastCount > 0 ? 'LIVE' : 'STALE',
      errorRate: this.lastError ? 1 : 0,
      rateLimitState: { limited: false },
      credentialState: 'not-required',
      objectCount: this.lastCount,
      message: 'recorded demo data',
    };
    if (this.lastError) health.lastError = this.lastError.toInfo(new Date(this.context.clock.now()).toISOString());
    return health;
  }
}

function shiftObservation(o: Observation, shiftMs: number, providerId: string): Observation {
  const observedAt = new Date(Date.parse(o.observedAt) + shiftMs).toISOString();
  return {
    ...o,
    id: `${providerId}:${o.externalId ?? o.id}:${observedAt}`,
    providerId,
    observedAt,
    provenance: { ...o.provenance, providerId, origin: 'recorded' },
  };
}

export function createDemoEarthquakeProvider(fixturePath?: string): DemoEarthquakeProvider {
  return new DemoEarthquakeProvider(fixturePath);
}
