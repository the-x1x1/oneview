import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '@worldview/world-model';
import { PollingProvider, type FetchResult } from './helpers.js';
import { ProviderError } from './health.js';
import type { ProviderManifest } from './manifest.js';
import type { ProviderQuery } from './provider.js';
import { createFixtureContext, VirtualClock } from './testing.js';

const MANIFEST: ProviderManifest = {
  id: 'kept',
  name: 'Kept',
  version: '0.1.0',
  description: 'Answers from what it kept when its upstream fails.',
  objectTypes: ['satellite'],
  categories: ['space'],
  transport: 'http',
  capabilities: {
    live: true,
    historical: false,
    offline: false,
    boundsQuery: false,
    answersFromCacheWhenUnavailable: true,
  },
  credentials: [],
  refreshPolicy: {
    intervalMs: 15_000,
    minIntervalMs: 15_000,
    timeoutMs: 30_000,
    maxRetries: 0,
    maxRequestsPerMinute: 10,
    staleWhileErrorMs: 0,
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: true,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: false,
    commercialUseAllowed: false,
    attributionRequired: true,
  },
  attribution: { text: 'Kept' },
  commercialReview: 'approved',
  enabledByDefault: false,
  allowedHosts: ['example.org'],
};

class Kept extends PollingProvider {
  readonly manifest = MANIFEST;
  next: FetchResult | Error = { observations: [] };
  protected async fetchOnce(_request: ProviderQuery): Promise<FetchResult> {
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

const query = (p: Kept) => p.query({ signal: new AbortController().signal, background: true });

test('an answer through an upstream failure: returned, the failure kept as the last error, STALE not LIVE', async () => {
  const p = new Kept();
  await p.initialize(
    createFixtureContext({ providerId: 'kept', clock: new VirtualClock(Date.parse('2026-10-05T00:00:00Z')) }),
  );
  await p.start();
  await query(p);
  assert.equal((await p.health()).status, 'LIVE');
  const kept = [{ id: 'o' } as unknown as Observation];
  p.next = { observations: kept, cacheAgeMs: 3 * 3600_000, unavailable: new ProviderError('HTTP_5XX', 'HTTP 503') };
  assert.equal(await query(p), kept, 'the kept answer is returned');
  const h = await p.health();
  assert.equal(h.status, 'STALE');
  assert.equal(h.lastError?.code, 'HTTP_5XX');
  assert.equal(h.message, 'HTTP 503');
  assert.ok(h.errorRate > 0, 'counted as a failure');
  // A refusal reads as one, with its reset time.
  p.next = {
    observations: kept,
    cacheAgeMs: 3 * 3600_000,
    unavailable: new ProviderError('RATE_LIMITED', 'HTTP 403', { retryAfterMs: 7_200_000 }),
  };
  await query(p);
  const limited = await p.health();
  assert.equal(limited.status, 'RATE_LIMITED');
  assert.ok(limited.rateLimitState.resetAt);
  // A thrown failure afterwards is a failure as before.
  p.next = new ProviderError('TIMEOUT', 'request timed out');
  await assert.rejects(query(p), /timed out/);
  assert.equal((await p.health()).status, 'DEGRADED');
  // And a real answer clears it all.
  p.next = { observations: [] };
  await query(p);
  const back = await p.health();
  assert.equal(back.status, 'LIVE');
  assert.equal(back.lastError, undefined);
});
