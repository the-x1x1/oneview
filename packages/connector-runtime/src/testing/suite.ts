import { testing, ProviderError, type WorldProvider } from '@worldview/provider-sdk';
import { observationSchema, type Observation } from '@worldview/world-model';
import { compileMapping, mapRecord } from '@worldview/connector-sdk';
import { ConnectorRegistry, defaultConnectorRegistry } from '../registry.js';

/**
 * The shared connector test suite (directive §73): every connector, run against a
 * definition and fixtures, must pass the same checks — config validation, a successful
 * parse, empty and malformed responses, timeout, auth failure, rate limit, mapping errors,
 * missing fields, an oversized payload, cancellation, attribution and data policy. Polling
 * connectors are driven through `query`; a subscription connector through a fixture socket.
 * The result is a list of named checks, each passed or failed with a reason, like the
 * provider contract checklist.
 */
export interface SuiteFixtures {
  /** The good response: body text (JSON, CSV, …). For a socket connector, the messages. */
  normal: string | string[];
  /** A response with no records. */
  empty: string;
  /** Bodies that must be reported MALFORMED (a poll) or ignored (a socket). */
  malformed: string[];
  /** How many observations `normal` yields. */
  expectObservations: number;
  /** External ids that must be among them. */
  expectIds?: string[];
  verify?: (observations: Observation[]) => string | undefined;
}

export interface SuiteCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface SuiteResult {
  definitionId: string;
  connector: string;
  checks: SuiteCheck[];
  passed: boolean;
}

const NOW = Date.parse('2026-09-23T20:00:00.000Z');

export async function runConnectorSuite(
  doc: unknown,
  fixtures: SuiteFixtures,
  registry: ConnectorRegistry = defaultConnectorRegistry,
): Promise<SuiteResult> {
  const checks: SuiteCheck[] = [];
  const check = (name: string, fn: () => Promise<string | undefined> | string | undefined) =>
    Promise.resolve()
      .then(fn)
      .then(
        (detail) => checks.push({ name, passed: detail === undefined, detail: detail ?? 'ok' }),
        (err) => checks.push({ name, passed: false, detail: err instanceof Error ? err.message : String(err) }),
      );

  const validated = registry.validate(doc);
  await check('Config validation', () => (validated.ok ? undefined : validated.errors.join('; ')));
  const definition = validated.definition;
  if (!validated.ok || !definition)
    return { definitionId: String((doc as { id?: unknown })?.id ?? '?'), connector: '?', checks, passed: false };
  const socket = Boolean(definition.websocket);

  const make = async (responder: testing.FixtureResponder, sockets?: testing.FixtureSockets) => {
    const provider = registry.createProvider(definition);
    const ctx = testing.createFixtureContext({
      providerId: definition.id,
      clock: new testing.VirtualClock(NOW),
      responder,
      credentials: Object.values(definition.credentials ?? {}).map((c) => c.secretRef),
      ...(sockets ? { sockets } : {}),
    });
    await provider.initialize(ctx);
    await provider.start();
    return { provider, ctx };
  };
  const query = (provider: WorldProvider, signal = new AbortController().signal) =>
    provider.query!({ signal, background: true, bounds: { west: -160, south: 18, east: -154, north: 23 } });
  const bodyOf = (text: string) => ({ status: 200, body: text });

  let normalObservations: Observation[] = [];
  if (!socket) {
    const normal = Array.isArray(fixtures.normal) ? fixtures.normal[0]! : fixtures.normal;
    await check('Successful parse', async () => {
      const { provider } = await make(() => bodyOf(normal));
      normalObservations = await query(provider);
      if (normalObservations.length !== fixtures.expectObservations)
        return `expected ${fixtures.expectObservations} observations, got ${normalObservations.length}`;
      for (const id of fixtures.expectIds ?? [])
        if (!normalObservations.some((o) => o.externalId === id)) return `missing observation ${id}`;
      for (const o of normalObservations) {
        const r = observationSchema.parse(o);
        if (!r.ok) return `observation ${o.id} invalid: ${r.issues[0]?.message}`;
        if (o.objectType !== definition.objectType) return `observation ${o.id} is a ${o.objectType}`;
      }
      return fixtures.verify?.(normalObservations);
    });
    await check('Empty response', async () => {
      const { provider } = await make(() => bodyOf(fixtures.empty));
      const obs = await query(provider);
      if (obs.length !== 0) return `empty fixture produced ${obs.length} observations`;
      const h = await provider.health();
      return h.status === 'LIVE' ? undefined : `health ${h.status} after an empty response`;
    });
    await check('Malformed response', async () => {
      for (const [i, body] of fixtures.malformed.entries()) {
        const { provider } = await make(() => bodyOf(body));
        try {
          await query(provider);
          return `malformed[${i}] was accepted`;
        } catch (err) {
          if (!(err instanceof ProviderError) || err.code !== 'MALFORMED')
            return `malformed[${i}]: expected MALFORMED, got ${err instanceof ProviderError ? err.code : String(err)}`;
        }
      }
      return undefined;
    });
    await check('Timeout', async () => {
      const { provider } = await make(() => ({ error: 'timeout' }));
      try {
        await query(provider);
        return 'query resolved under a timeout';
      } catch (err) {
        return err instanceof ProviderError && err.code === 'TIMEOUT'
          ? undefined
          : `expected TIMEOUT, got ${String(err)}`;
      }
    });
    await check('Auth failure', async () => {
      const { provider } = await make(() => ({ status: 401 }));
      try {
        await query(provider);
        return 'query resolved under 401';
      } catch (err) {
        return err instanceof ProviderError && err.code === 'AUTH' ? undefined : `expected AUTH, got ${String(err)}`;
      }
    });
    await check('Rate limit', async () => {
      const { provider } = await make(() => ({ status: 429, headers: { 'retry-after': '30' } }));
      try {
        await query(provider);
        return 'query resolved under 429';
      } catch (err) {
        return err instanceof ProviderError && err.code === 'RATE_LIMITED'
          ? undefined
          : `expected RATE_LIMITED, got ${String(err)}`;
      }
    });
    await check('Oversized payload', async () => {
      const { provider } = await make(() => ({ error: 'too-large' }));
      try {
        await query(provider);
        return 'query resolved on an oversized body';
      } catch (err) {
        return err instanceof ProviderError && err.code === 'TOO_LARGE'
          ? undefined
          : `expected TOO_LARGE, got ${String(err)}`;
      }
    });
    await check('Cancellation', async () => {
      const { provider } = await make(() => bodyOf(normal));
      const abort = new AbortController();
      abort.abort();
      try {
        await query(provider, abort.signal);
        return 'query resolved despite a pre-aborted signal';
      } catch (err) {
        return err instanceof ProviderError && err.code === 'CANCELLED'
          ? undefined
          : `expected CANCELLED, got ${String(err)}`;
      }
    });
    await check('Mapping error', async () => {
      // A definition whose required id path matches nothing: every record rejected → MALFORMED.
      const broken = { ...(doc as object), mapping: { ...definition.mapping, externalId: 'no.such.path.anywhere' } };
      const v = registry.validate(broken);
      if (!v.ok || !v.definition) return `broken mapping did not validate: ${v.errors.join('; ')}`;
      const provider = registry.createProvider(v.definition);
      const ctx = testing.createFixtureContext({
        providerId: definition.id,
        clock: new testing.VirtualClock(NOW),
        responder: () => bodyOf(normal),
      });
      await provider.initialize(ctx);
      await provider.start();
      try {
        const obs = await query(provider);
        return obs.length === 0 ? undefined : `records mapped without an id: ${obs.length}`;
      } catch (err) {
        return err instanceof ProviderError && err.code === 'MALFORMED'
          ? undefined
          : `expected MALFORMED, got ${String(err)}`;
      }
    });
  } else {
    const messages = Array.isArray(fixtures.normal) ? fixtures.normal : [fixtures.normal];
    const settle = (definition.websocket?.flushMs ?? 500) + 50;
    await check('Successful parse', async () => {
      const sockets = new testing.FixtureSockets();
      const { provider } = await make(() => ({ status: 404 }), sockets);
      const emitted: Observation[] = [];
      const abort = new AbortController();
      await provider.subscribe!({ signal: abort.signal }, (obs) => emitted.push(...obs));
      const s = sockets.opened[0]?.handle;
      if (!s) return 'no socket opened';
      s.simulateOpen({ secret: 'test-secret' });
      if (definition.websocket?.subscribe !== undefined) {
        const sent = s.sent[0];
        if (!sent) return 'no subscribe frame sent on open';
        if (typeof sent === 'string' && sent.includes('{secret}')) return 'subscribe frame still carries {secret}';
      }
      for (const m of messages) s.simulateMessage(m);
      await new Promise((r) => setTimeout(r, settle));
      abort.abort();
      normalObservations = emitted;
      if (emitted.length !== fixtures.expectObservations)
        return `expected ${fixtures.expectObservations} observations, got ${emitted.length}`;
      for (const id of fixtures.expectIds ?? [])
        if (!emitted.some((o) => o.externalId === id)) return `missing observation ${id}`;
      for (const o of emitted) {
        const r = observationSchema.parse(o);
        if (!r.ok) return `observation ${o.id} invalid: ${r.issues[0]?.message}`;
      }
      return fixtures.verify?.(emitted);
    });
    await check('Empty response', async () => {
      const sockets = new testing.FixtureSockets();
      const { provider } = await make(() => ({ status: 404 }), sockets);
      const emitted: Observation[] = [];
      await provider.subscribe!({ signal: new AbortController().signal }, (obs) => emitted.push(...obs));
      sockets.opened[0]!.handle.simulateOpen({});
      sockets.opened[0]!.handle.simulateMessage(fixtures.empty);
      await new Promise((r) => setTimeout(r, settle));
      return emitted.length === 0 ? undefined : `empty message produced ${emitted.length} observations`;
    });
    await check('Malformed response', async () => {
      const sockets = new testing.FixtureSockets();
      const { provider } = await make(() => ({ status: 404 }), sockets);
      const emitted: Observation[] = [];
      await provider.subscribe!({ signal: new AbortController().signal }, (obs) => emitted.push(...obs));
      sockets.opened[0]!.handle.simulateOpen({});
      for (const m of fixtures.malformed) sockets.opened[0]!.handle.simulateMessage(m);
      await new Promise((r) => setTimeout(r, settle));
      const h = await provider.health();
      if (emitted.length) return `malformed messages produced ${emitted.length} observations`;
      return h.status === 'LIVE' ? undefined : `health ${h.status} after malformed messages`;
    });
    await check('Cancellation', async () => {
      const sockets = new testing.FixtureSockets();
      const { provider } = await make(() => ({ status: 404 }), sockets);
      const abort = new AbortController();
      await provider.subscribe!({ signal: abort.signal }, () => undefined);
      abort.abort();
      return sockets.opened[0]?.handle.closed ? undefined : 'socket not closed on abort';
    });
    await check('Reconnect', async () => {
      const sockets = new testing.FixtureSockets();
      const { provider } = await make(() => ({ status: 404 }), sockets);
      await provider.subscribe!({ signal: new AbortController().signal }, () => undefined);
      sockets.opened[0]!.handle.simulateOpen({});
      sockets.opened[0]!.handle.simulateClose(1006, 'gone');
      const h = await provider.health();
      return h.status === 'OFFLINE' ? undefined : `expected OFFLINE after the socket closed, got ${h.status}`;
    });
  }

  await check('Missing fields', () => {
    // A record with nothing in it, and one with only an id: the mapping answers with a
    // rejection and a reason, never a throw, and never an observation without a position.
    const mapping = compileMapping(definition.mapping);
    for (const [what, record] of [
      ['an empty record', {}],
      ['a record with only an id', { id: 'x', externalId: 'x', station_id: 'x', properties: { id: 'x' } }],
    ] as const) {
      let r: ReturnType<typeof mapRecord>;
      try {
        r = mapRecord(record, mapping);
      } catch (err) {
        return `${what} threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (r.ok) {
        if (r.record.position) return `${what} mapped to a positioned observation`;
        continue;
      }
      if (!('skipped' in r) && !r.reason) return `${what} was rejected without a reason`;
    }
    return undefined;
  });
  await check('Attribution', () => {
    const provider = registry.createProvider(definition);
    if (!provider.manifest.attribution.text) return 'no attribution text';
    return normalObservations.every((o) => o.provenance.attribution === provider.manifest.attribution.text)
      ? undefined
      : 'observations do not carry the manifest attribution';
  });
  await check('Data policy', () => {
    const provider = registry.createProvider(definition);
    const p = provider.manifest.dataPolicy;
    const review = definition.review ?? 'user-configured';
    if (review === 'user-configured') {
      if (p.commercialUseAllowed !== 'unknown')
        return 'a user-configured source must have commercialUseAllowed unknown';
      if (p.redistributionAllowed || p.offlinePackAllowed || p.exportAllowed)
        return 'a user-configured source must not redistribute, pack or export';
    }
    if (provider.manifest.enabledByDefault && provider.manifest.commercialReview === 'manual-review-required')
      return 'enabled by default without review';
    return undefined;
  });
  await check('Rate policy', () => {
    const m = registry.createProvider(definition).manifest.refreshPolicy;
    if (m.intervalMs < 5000) return `interval ${m.intervalMs} ms is below 5 s`;
    if (m.maxRequestsPerMinute * m.intervalMs < 60_000) return 'the request limit does not cover the poll cadence';
    return undefined;
  });

  return {
    definitionId: definition.id,
    connector: definition.connector,
    checks,
    passed: checks.every((c) => c.passed),
  };
}

export function formatSuite(r: SuiteResult): string {
  const lines = [`${r.definitionId} (${r.connector})`];
  for (const c of r.checks) lines.push(`  ${c.name.padEnd(20)} ${c.passed ? 'PASS' : 'FAIL'}  ${c.detail}`);
  lines.push(
    `  ${r.checks.filter((c) => c.passed).length} pass, ${r.checks.filter((c) => !c.passed).length} fail → ${r.passed ? 'PASS' : 'FAIL'}`,
  );
  return lines.join('\n');
}
