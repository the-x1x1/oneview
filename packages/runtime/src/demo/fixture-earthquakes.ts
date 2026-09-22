import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Observation } from '@worldview/world-model';
import { USGS_MANIFEST, normalizeUsgsFeed } from '@worldview/provider-usgs';
import {
  ProviderError,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
  type WorldProvider,
} from '@worldview/provider-sdk';

/**
 * Demo earthquake provider: the USGS contract fixture, read from disk, normalized by the
 * real USGS normalizer, with every observation marked `provenance.origin: 'recorded'` so
 * the shell labels it RECORDED DATA. It never touches the network and its manifest is
 * the USGS manifest with the transport changed to `filesystem`, so source health reports
 * it as a bundled source rather than a live remote feed.
 */
/**
 * Where the recorded feed lives. In a packaged application it is a staged resource; in a
 * source checkout it is the fixture itself.
 *
 * `import.meta.url` is NOT usable for this: the Electron main process is bundled to CJS,
 * where esbuild leaves `import.meta` empty, so a path derived from it resolved against
 * the filesystem root and demo mode read nothing. The build warns about that — the
 * warning was there and had not been acted on.
 */
export const DEMO_EARTHQUAKE_FIXTURE = 'demo-earthquakes.geojson';

function repoFixture(): string {
  return path.resolve(process.cwd(), 'fixtures', 'usgs', 'normal.geojson');
}

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

  /**
   * `fixturePath` names the file outright (tests). `resourcesDir` is the packaged
   * application's read-only data directory, where the fixture is staged. With neither,
   * the repository copy is used, which is what a source checkout has.
   */
  constructor(
    private readonly fixturePath?: string,
    private readonly resourcesDir?: string,
  ) {}

  private resolved: string | undefined;

  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
  }

  private async fixture(): Promise<string> {
    if (this.fixturePath) return this.fixturePath;
    if (this.resolved) return this.resolved;
    const candidates = [
      ...(this.resourcesDir ? [path.join(this.resourcesDir, DEMO_EARTHQUAKE_FIXTURE)] : []),
      repoFixture(),
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        this.resolved = candidate;
        return candidate;
      } catch {
        /* try the next */
      }
    }
    this.resolved = candidates[candidates.length - 1]!;
    return this.resolved;
  }
  async start(): Promise<void> {
    this.running = true;
  }
  async stop(): Promise<void> {
    this.running = false;
  }

  async query(request: ProviderQuery): Promise<Observation[]> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled');
    const fixturePath = await this.fixture();
    let text: string;
    try {
      text = await fs.readFile(fixturePath, 'utf8');
    } catch (err) {
      this.lastError = new ProviderError(
        'UNSUPPORTED',
        `demo fixture ${path.basename(fixturePath)} is not readable at ${fixturePath}`,
        { cause: err, retryable: false },
      );
      throw this.lastError;
    }
    const now = this.context.clock.now();
    const result = normalizeUsgsFeed(JSON.parse(text) as unknown, {
      receivedAt: new Date(now).toISOString(),
      hash: (s) => this.context.hash.sha256Hex(s),
      origin: 'recorded',
      sourceRef: `fixtures/usgs/${path.basename(fixturePath)}`,
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

export function createDemoEarthquakeProvider(fixturePath?: string, resourcesDir?: string): DemoEarthquakeProvider {
  return new DemoEarthquakeProvider(fixturePath, resourcesDir);
}
