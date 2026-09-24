import { ProviderHost, type ObservationBatch } from '@worldview/provider-runtime';
import { LoggerHub, RingBufferSink } from '@worldview/core';
import { testing } from '@worldview/provider-sdk';
import { systemClock } from '@worldview/world-model';
import type { ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { defaultConnectorRegistry, type ConnectorRegistry } from '@worldview/connector-runtime';

/**
 * One live sample through the real provider host: the definition's provider is registered
 * with the same HTTP client, host allow-list, rate limit and credential scoping the desktop
 * uses, polled once (or, for a subscription, listened to for a few seconds), and the result
 * reported. Secrets come only from the environment — `ONEVIEW_SECRET_<SECRET_REF>` with the
 * ref upper-cased and non-alphanumerics as `_` — and are never printed.
 */
export interface LiveOptions {
  registry?: ConnectorRegistry;
  /** How long a subscription connector is listened to. */
  listenMs?: number;
  bounds?: { west: number; south: number; east: number; north: number };
}

export interface LiveResult {
  observations: number;
  rejected: number;
  status: string;
  message?: string;
  sample?: { id: string; externalId?: string; observedAt: string; latitude?: number; longitude?: number };
  warnings: string[];
  errors: string[];
}

export function secretEnvName(secretRef: string): string {
  return `ONEVIEW_SECRET_${secretRef.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

export async function runLive(definition: ConnectorProviderDefinition, opts: LiveOptions = {}): Promise<LiveResult> {
  const registry = opts.registry ?? defaultConnectorRegistry;
  const sink = new RingBufferSink();
  const hub = new LoggerHub({ level: 'debug', sinks: [sink] });
  const missing: string[] = [];
  for (const c of Object.values(definition.credentials ?? {}))
    if (!process.env[secretEnvName(c.secretRef)]) missing.push(`${c.secretRef} (set ${secretEnvName(c.secretRef)})`);
  const host = new ProviderHost({
    clock: systemClock,
    loggerHub: hub,
    manualScheduling: true,
    userAgent: 'OneView connector validator',
    credentials: {
      get: async (key) => process.env[secretEnvName(key)],
      has: async (key) => Boolean(process.env[secretEnvName(key)]),
    },
    cacheStore: (_id, allowed) => new testing.MemoryCache(systemClock, allowed),
    settingsStore: () => new testing.MemorySettings({}),
  });
  const batches: ObservationBatch[] = [];
  host.onObservations((b) => batches.push(b));
  const provider = registry.createProvider(definition);
  host.register(provider, { enabled: true });
  host.setViewport(opts.bounds ?? { west: -180, south: -85, east: 180, north: 85 }, { latitude: 0, longitude: 0 });
  const errors: string[] = [];
  try {
    await host.start();
    if (definition.websocket) await new Promise((r) => setTimeout(r, opts.listenMs ?? 8000));
    else {
      const batch = await host.pollNow(definition.id);
      if (batch) batches.push(batch);
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const health = await host.healthOf(definition.id);
  await host.dispose();
  const observations = batches.reduce((n, b) => n + b.observations.length, 0);
  const rejected = batches.reduce((n, b) => n + b.rejected, 0);
  const first = batches.find((b) => b.observations.length)?.observations[0];
  const warnings = missing.map((m) => `credential not set: ${m}`);
  for (const r of sink.records) {
    if (r.level === 'error') errors.push(`${r.message}${r.fields ? ' ' + JSON.stringify(r.fields) : ''}`);
    else if (r.level === 'warn') warnings.push(`${r.message}${r.fields ? ' ' + JSON.stringify(r.fields) : ''}`);
  }
  const result: LiveResult = {
    observations,
    rejected,
    status: health?.status ?? 'UNKNOWN',
    warnings,
    errors,
  };
  if (health?.message) result.message = health.message;
  if (first)
    result.sample = {
      id: first.id,
      ...(first.externalId ? { externalId: first.externalId } : {}),
      observedAt: first.observedAt,
      ...(first.position ? { latitude: first.position.latitude, longitude: first.position.longitude } : {}),
    };
  return result;
}
