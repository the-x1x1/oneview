import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { manifestSchema, dataPolicySchema, ProviderError, testing, type ProviderHealth, type WorldProvider, type ProviderManifest } from '@worldview/provider-sdk';
import { classifyFreshness, freshnessPolicyFor, formatIssues, isAuthoritativeId, observationSchema, type Observation } from '@worldview/world-model';
import { WorldState } from '@worldview/state-engine';
import type { ProviderTestPlan } from './plan.js';

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';
export interface CheckResult { check: string; status: CheckStatus; detail: string; durationMs: number }
export interface ValidationReport {
  providerId: string;
  version: string;
  ranAt: string;
  node: string;
  checks: CheckResult[];
  passed: boolean;
  summary: { pass: number; fail: number; skip: number };
  evidence: {
    observations: number;
    objectTypes: string[];
    sampleObjectIds: string[];
    healthAfterNormal?: ProviderHealth;
  };
}

export const CHECKLIST = ['Manifest', 'Data Policy', 'Initialization', 'Fixture', 'Normalization', 'Health', 'Cancellation', 'Timeout', 'Stale Detection', 'Attribution', 'World Mapping', 'Empty Feed', 'Malformed Feed', 'Rate Limit', 'Auth Failure', 'Offline'] as const;

interface RegistryRecord { providerId: string; dataPolicy: Record<string, unknown>; commercialReview: string; plannedStatus: string }

function loadRegistry(root: string): RegistryRecord[] {
  const file = path.join(root, 'config', 'licenses', 'providers.json');
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, 'utf8')) as { records: RegistryRecord[] }).records;
}

export async function runProviderChecklist(plan: ProviderTestPlan, opts: { repoRoot: string }): Promise<ValidationReport> {
  const checks: CheckResult[] = [];
  const evidence: ValidationReport['evidence'] = { observations: 0, objectTypes: [], sampleObjectIds: [] };
  const registry = loadRegistry(opts.repoRoot);
  let manifest: ProviderManifest | undefined;
  let provider: WorldProvider | undefined;
  let normal: Observation[] = [];
  let ctx: testing.FixtureContext | undefined;
  let scenario: 'normal' | 'empty' | 'stale' | 'timeout' | 'malformed' | 'rate' | 'auth' | 'server-error' = 'normal';
  let malformedIndex = 0;
  const clockStart = plan.clockStartMs ?? Date.parse('2026-09-21T08:05:00.000Z');

  const run = async (name: (typeof CHECKLIST)[number], fn: () => Promise<string> | string): Promise<void> => {
    const t = performance.now();
    try {
      const detail = await fn();
      checks.push({ check: name, status: detail.startsWith('SKIP:') ? 'SKIP' : 'PASS', detail, durationMs: Math.round(performance.now() - t) });
    } catch (err) {
      checks.push({ check: name, status: 'FAIL', detail: err instanceof Error ? err.message : String(err), durationMs: Math.round(performance.now() - t) });
    }
  };
  const fail = (msg: string): never => { throw new Error(msg); };
  const need = <T,>(v: T | undefined, what: string): T => { if (v === undefined) throw new Error(`${what} unavailable (earlier check failed)`); return v; };

  await run('Manifest', () => {
    provider = plan.create();
    const r = manifestSchema.parse(provider.manifest);
    if (!r.ok) return fail(`manifest invalid: ${formatIssues(r.issues)}`);
    const m = r.value;
    manifest = m;
    if (m.id !== plan.providerDir && !m.id.startsWith(plan.providerDir) && !plan.aliases?.includes(m.id)) fail(`manifest.id ${m.id} does not match providers/${plan.providerDir}`);
    if (plan.profile === 'local' && (m.transport === 'http' || m.transport === 'websocket')) fail(`profile 'local' but transport is ${m.transport}`);
    const rec = registry.find((x) => x.providerId === m.id);
    if (registry.length && !rec) fail(`no record for ${m.id} in config/licenses/providers.json`);
    if (rec && rec.commercialReview !== m.commercialReview) fail(`commercialReview mismatch: manifest=${m.commercialReview} registry=${rec.commercialReview}`);
    if (rec && rec.plannedStatus === 'excluded' && m.enabledByDefault) fail('excluded provider is enabledByDefault');
    return `id=${m.id} v${m.version} transport=${m.transport} review=${m.commercialReview}`;
  });

  await run('Data Policy', () => {
    const m = need(manifest, 'manifest');
    const r = dataPolicySchema.parse(m.dataPolicy);
    if (!r.ok) fail(formatIssues(r.issues));
    const rec = registry.find((x) => x.providerId === m.id);
    if (rec) {
      const diffs: string[] = [];
      const mp = m.dataPolicy as unknown as Record<string, unknown>;
      for (const k of ['cacheAllowed', 'rawPayloadRetentionAllowed', 'normalizedRetentionAllowed', 'redistributionAllowed', 'offlinePackAllowed', 'exportAllowed', 'commercialUseAllowed', 'attributionRequired'] as const) {
        if (rec.dataPolicy[k] !== mp[k]) diffs.push(`${k}: manifest=${String(mp[k])} registry=${String(rec.dataPolicy[k])}`);
      }
      if (diffs.length) fail(`data policy diverges from legal registry: ${diffs.join('; ')}`);
    }
    const p = m.dataPolicy;
    return `cache=${p.cacheAllowed} raw=${p.rawPayloadRetentionAllowed} norm=${p.normalizedRetentionAllowed} redistribute=${p.redistributionAllowed} pack=${p.offlinePackAllowed} export=${p.exportAllowed} commercial=${String(p.commercialUseAllowed)}${rec ? ' (matches legal registry)' : ''}`;
  });

  await run('Initialization', async () => {
    const p = need(provider, 'provider');
    const m = need(manifest, 'manifest');
    ctx = testing.createFixtureContext({
      providerId: m.id,
      clock: new testing.VirtualClock(clockStart),
      ...(plan.credentials ? { credentials: plan.credentials } : {}),
      ...(plan.settings ? { settings: plan.settings } : {}),
      responder: (req) => {
        switch (scenario) {
          case 'empty': return plan.fixtures.empty ? plan.fixtures.empty(req) : { status: 200, body: '' };
          case 'stale': return plan.fixtures.stale ? plan.fixtures.stale(req) : plan.fixtures.normal(req);
          case 'timeout': return { error: 'timeout' };
          case 'malformed': return plan.fixtures.malformed![malformedIndex]!(req);
          case 'rate': return { status: 429, headers: { 'retry-after': '45' } };
          case 'auth': return { status: 401 };
          case 'server-error': return { status: 503 };
          default: return plan.fixtures.normal(req);
        }
      },
    });
    await p.initialize(ctx);
    await p.start();
    const h = await p.health();
    if (h.providerId !== m.id) fail('health.providerId mismatch');
    if (!['STARTING', 'LIVE', 'AUTH_REQUIRED'].includes(h.status)) fail(`unexpected status after start: ${h.status}`);
    return `status=${h.status} credentialState=${h.credentialState}`;
  });

  await run('Fixture', async () => {
    const p = need(provider, 'provider');
    const c = need(ctx, 'context');
    if (p.query) {
      normal = await p.query({ signal: new AbortController().signal, background: false });
    } else if (p.subscribe && plan.subscription) {
      const got: Observation[] = [];
      const unsub = await p.subscribe({ signal: new AbortController().signal }, (obs) => got.push(...obs));
      const sock = need(c.sockets.opened[0]?.handle, 'fixture socket');
      sock.simulateOpen();
      for (const frame of plan.subscription.frames) sock.simulateMessage(frame);
      await new Promise((r) => setTimeout(r, 10));
      unsub();
      normal = got;
    } else fail('provider has neither query nor subscribe');
    if (normal.length < plan.expectations.minObservations) fail(`expected ≥${plan.expectations.minObservations} observations, got ${normal.length}`);
    evidence.observations = normal.length;
    return `${normal.length} observations from normal fixture`;
  });

  await run('Normalization', () => {
    const m = need(manifest, 'manifest');
    const ids = new Set<string>();
    const types = new Set<string>();
    normal.forEach((o, i) => {
      const r = observationSchema.parse(o);
      if (!r.ok) fail(`observation[${i}] invalid: ${formatIssues(r.issues)}`);
      if (o.providerId !== m.id) fail(`observation[${i}].providerId=${o.providerId}`);
      if (!m.objectTypes.includes(o.objectType)) fail(`observation[${i}].objectType ${o.objectType} not declared in manifest`);
      if (ids.has(o.id)) fail(`duplicate observation id ${o.id}`);
      ids.add(o.id);
      types.add(o.objectType);
      if (Date.parse(o.observedAt) > Date.parse(o.receivedAt) + 5 * 60_000) fail(`observation[${i}] observedAt is in the future relative to receivedAt`);
      if (o.rawPayloadHash && !m.dataPolicy.rawPayloadRetentionAllowed) fail('rawPayloadHash present but raw retention not allowed');
    });
    for (const t of plan.expectations.objectTypes) if (!types.has(t)) fail(`expected objectType ${t} not produced`);
    const custom = plan.expectations.verify?.(normal);
    if (custom) fail(custom);
    evidence.objectTypes = [...types];
    return `all ${normal.length} observations valid; types=${[...types].join(',')}`;
  });

  await run('Health', async () => {
    const h = await need(provider, 'provider').health();
    evidence.healthAfterNormal = h;
    if (h.status !== 'LIVE') fail(`expected LIVE after successful fetch, got ${h.status} (${h.message ?? ''})`);
    if (!h.lastSuccess) fail('lastSuccess missing');
    if (!h.lastAttempt) fail('lastAttempt missing');
    if (h.errorRate !== 0) fail(`errorRate ${h.errorRate}`);
    const custom = plan.expectations.verifyHealth?.(h);
    if (custom) fail(custom);
    return `status=${h.status} latencyMs=${h.latencyMs ?? 'n/a'} lastObservation=${h.lastObservation ?? 'n/a'}`;
  });

  await run('Cancellation', async () => {
    const p = need(provider, 'provider');
    if (!p.query) return 'SKIP: subscription provider';
    const ac = new AbortController();
    ac.abort();
    try {
      await p.query({ signal: ac.signal, background: true });
      fail('query resolved despite pre-aborted signal');
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== 'CANCELLED') fail(`expected CANCELLED ProviderError, got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    const h = await p.health();
    if (h.status === 'ERROR') fail('cancellation was recorded as an error');
    return `CANCELLED surfaced; health=${h.status}`;
  });

  const local = plan.profile === 'local';

  await run('Timeout', async () => {
    const p = need(provider, 'provider');
    if (!p.query) return 'SKIP: subscription provider';
    if (local) return 'SKIP: local transport (no network path)';
    scenario = 'timeout';
    try {
      await p.query({ signal: new AbortController().signal, background: true });
      fail('query resolved during timeout scenario');
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== 'TIMEOUT') fail(`expected TIMEOUT ProviderError, got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    } finally { scenario = 'normal'; }
    const h = await p.health();
    if (!['DEGRADED', 'ERROR', 'STALE'].includes(h.status)) fail(`expected DEGRADED/ERROR after timeout, got ${h.status}`);
    if (!h.lastError || h.lastError.code !== 'TIMEOUT') fail('lastError not recorded');
    await p.query({ signal: new AbortController().signal, background: true });
    const h2 = await p.health();
    if (h2.status !== 'LIVE') fail(`did not recover to LIVE after timeout, got ${h2.status}`);
    return `timeout → ${h.status}, recovered → ${h2.status}`;
  });

  await run('Stale Detection', async () => {
    const p = need(provider, 'provider');
    const m = need(manifest, 'manifest');
    if (!p.query) return 'SKIP: subscription provider';
    if (!plan.fixtures.stale) return 'SKIP: no stale fixture';
    scenario = 'stale';
    let obs: Observation[];
    try { obs = await p.query({ signal: new AbortController().signal, background: true }); } finally { scenario = 'normal'; }
    if (obs.length === 0) fail('stale fixture produced no observations');
    const now = need(ctx, 'context').clock.now();
    const type = obs[0]!.objectType;
    const policy = m.refreshPolicy.freshness?.[type] ?? freshnessPolicyFor(type);
    const classes = new Set(obs.map((o) => classifyFreshness(Date.parse(o.observedAt), now, policy)));
    if (![...classes].every((c) => c === 'STALE' || c === 'RECENT')) fail(`stale observations classified as ${[...classes].join(',')}`);
    return `stale fixture → freshness ${[...classes].join(',')} under ${type} policy (live≤${policy.liveSeconds}s)`;
  });

  await run('Attribution', () => {
    const m = need(manifest, 'manifest');
    if (!m.attribution.text.trim()) fail('manifest.attribution.text empty');
    for (const o of normal) if (o.provenance.attribution !== m.attribution.text) fail(`observation ${o.id} attribution "${o.provenance.attribution}" ≠ manifest`);
    if (m.dataPolicy.attributionRequired && !m.dataPolicy.attributionText) fail('attributionRequired but attributionText missing');
    return `"${m.attribution.text}" on all ${normal.length} observations`;
  });

  await run('World Mapping', () => {
    const m = need(manifest, 'manifest');
    const c = need(ctx, 'context');
    const clock = { now: () => c.clock.now() };
    const stateA = new WorldState({ clock, flushDelayMs: 0 });
    const stateB = new WorldState({ clock, flushDelayMs: 0 });
    const meta = { snapshot: true, providerId: m.id, ...(m.refreshPolicy.freshness ? { freshness: m.refreshPolicy.freshness } : {}) };
    const rA = stateA.ingest(normal, meta);
    const rB = stateB.ingest([...normal].reverse(), meta);
    if (rA.rejected.length) fail(`state rejected ${rA.rejected.length}: ${rA.rejected[0]!.reason}`);
    const idsA = [...stateA.ids()].sort();
    const idsB = [...stateB.ids()].sort();
    if (idsA.join() !== idsB.join()) fail('object ids are not deterministic across ingest order');
    for (const id of plan.expectations.expectObjectIds ?? []) if (!stateA.has(id)) fail(`expected object ${id} missing`);
    const authoritative = idsA.filter(isAuthoritativeId).length;
    for (const obj of stateA.all()) {
      if (!obj.freshness || obj.confidence < 0 || obj.confidence > 1) fail(`object ${obj.id} freshness/confidence invalid`);
      if (obj.sourceRefs.length === 0) fail(`object ${obj.id} has no sourceRefs`);
    }
    evidence.sampleObjectIds = idsA.slice(0, 5);
    return `${stateA.size} objects (${authoritative} authoritative ids); deterministic across order; freshness=${[...new Set([...stateA.all()].map((o) => o.freshness))].join(',')}`;
  });

  await run('Empty Feed', async () => {
    const p = need(provider, 'provider');
    if (!p.query) return 'SKIP: subscription provider';
    if (!plan.fixtures.empty) return 'SKIP: no empty fixture';
    scenario = 'empty';
    let obs: Observation[];
    try { obs = await p.query({ signal: new AbortController().signal, background: true }); } finally { scenario = 'normal'; }
    if (obs.length !== 0) fail(`empty fixture produced ${obs.length} observations`);
    const h = await p.health();
    if (h.status !== 'LIVE') fail(`empty feed should be LIVE, got ${h.status}`);
    return 'empty feed → 0 observations, status LIVE';
  });

  await run('Malformed Feed', async () => {
    const p = need(provider, 'provider');
    if (!p.query) return 'SKIP: subscription provider';
    if (!plan.fixtures.malformed?.length) return 'SKIP: no malformed fixtures';
    const outcomes: string[] = [];
    for (malformedIndex = 0; malformedIndex < plan.fixtures.malformed.length; malformedIndex++) {
      scenario = 'malformed';
      try {
        const obs = await p.query({ signal: new AbortController().signal, background: true });
        for (const o of obs) { const r = observationSchema.parse(o); if (!r.ok) fail(`malformed[${malformedIndex}] leaked invalid observation`); }
        outcomes.push(`#${malformedIndex}: admitted ${obs.length} valid rows`);
      } catch (err) {
        if (!(err instanceof ProviderError)) return fail(`malformed[${malformedIndex}] threw a non-ProviderError: ${err instanceof Error ? err.message : String(err)}`);
        outcomes.push(`#${malformedIndex}: ${err.code}`);
      } finally { scenario = 'normal'; }
    }
    const h = await p.health();
    if (!['DEGRADED', 'ERROR', 'LIVE', 'STALE'].includes(h.status)) fail(`unexpected health ${h.status}`);
    await p.query({ signal: new AbortController().signal, background: true });
    if ((await p.health()).status !== 'LIVE') fail('did not recover after malformed feeds');
    return outcomes.join('; ') + '; recovered LIVE';
  });

  await run('Rate Limit', async () => {
    const p = need(provider, 'provider');
    if (!p.query) return 'SKIP: subscription provider';
    if (local) return 'SKIP: local transport (no network path)';
    scenario = 'rate';
    try {
      await p.query({ signal: new AbortController().signal, background: true });
      fail('query resolved under 429');
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== 'RATE_LIMITED') return fail(`expected RATE_LIMITED, got ${err instanceof Error ? err.message : String(err)}`);
      if (err.retryAfterMs !== 45_000) fail(`retryAfterMs ${err.retryAfterMs}`);
    } finally { scenario = 'normal'; }
    const h = await p.health();
    if (h.status !== 'RATE_LIMITED' || !h.rateLimitState.limited) fail(`expected RATE_LIMITED health, got ${h.status}`);
    await p.query({ signal: new AbortController().signal, background: true });
    return `429 → RATE_LIMITED (resetAt=${h.rateLimitState.resetAt ?? 'n/a'}), recovered`;
  });

  await run('Auth Failure', async () => {
    const p = need(provider, 'provider');
    if (!p.query) return 'SKIP: subscription provider';
    if (local) return 'SKIP: local transport (no network path)';
    scenario = 'auth';
    try {
      await p.query({ signal: new AbortController().signal, background: true });
      fail('query resolved under 401');
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== 'AUTH') fail(`expected AUTH, got ${err instanceof Error ? err.message : String(err)}`);
    } finally { scenario = 'normal'; }
    const h = await p.health();
    if (h.status !== 'AUTH_REQUIRED') fail(`expected AUTH_REQUIRED, got ${h.status}`);
    await p.query({ signal: new AbortController().signal, background: true });
    return '401 → AUTH_REQUIRED, recovered on next success';
  });

  await run('Offline', async () => {
    const p = need(provider, 'provider');
    const c = need(ctx, 'context');
    if (!p.query) return 'SKIP: subscription provider';
    if (local) {
      c.setOnline(false);
      let obs: Observation[];
      try { obs = await p.query({ signal: new AbortController().signal, background: true }); } finally { c.setOnline(true); }
      const h = await p.health();
      if (h.status !== 'LIVE') fail(`local provider must keep answering offline, got ${h.status}`);
      if (c.http.requests.length !== 0) fail(`local provider issued ${c.http.requests.length} http requests`);
      return `offline → ${obs.length} observations, status LIVE, no network requests`;
    }
    c.setOnline(false);
    try {
      await p.query({ signal: new AbortController().signal, background: true });
      fail('query resolved while offline');
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== 'OFFLINE') fail(`expected OFFLINE, got ${err instanceof Error ? err.message : String(err)}`);
    } finally { c.setOnline(true); }
    const h = await p.health();
    if (!['OFFLINE', 'DEGRADED'].includes(h.status)) fail(`expected OFFLINE/DEGRADED, got ${h.status}`);
    await p.query({ signal: new AbortController().signal, background: true });
    const h2 = await p.health();
    if (h2.status !== 'LIVE') fail(`did not recover after reconnect: ${h2.status}`);
    return `offline → ${h.status}; reconnect → LIVE`;
  });

  try { await provider?.stop(); } catch { /* ignore */ }

  const summary = { pass: checks.filter((c) => c.status === 'PASS').length, fail: checks.filter((c) => c.status === 'FAIL').length, skip: checks.filter((c) => c.status === 'SKIP').length };
  return {
    providerId: manifest?.id ?? plan.providerDir,
    version: manifest?.version ?? '0.0.0',
    ranAt: new Date().toISOString(),
    node: process.version,
    checks,
    passed: summary.fail === 0,
    summary,
    evidence,
  };
}

export function formatReport(report: ValidationReport): string {
  const width = Math.max(...report.checks.map((c) => c.check.length)) + 2;
  const lines = report.checks.map((c) => `${c.check.padEnd(width)}${c.status.padEnd(6)}${c.detail}`);
  return [`Provider ${report.providerId} v${report.version}`, ...lines, `${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.skip} skip → ${report.passed ? 'PASS' : 'FAIL'}`].join('\n');
}
