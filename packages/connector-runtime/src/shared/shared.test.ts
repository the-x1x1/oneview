import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '@worldview/world-model';
import type { ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { credentialRef, endpointCredential } from './credentials.js';
import { finiteNumber, isPlainObject } from './json.js';
import { RECONNECT_MAX_MS, RECONNECT_MIN_MS, nextRetryMs } from './limits.js';
import { addUnseen, rejectedMessage, responseOrigin, warnRejected } from './mapping.js';

// The helpers the connectors share. Each connector's own suite exercises them through the
// connector; these pin the rules themselves, so a change here is seen as a change to all.

const definition = (extra: Partial<ConnectorProviderDefinition>) =>
  ({ id: 'x', credentials: { key: { secretRef: 'x.key' } }, ...extra }) as unknown as ConnectorProviderDefinition;

test('credentials: the endpoint credential by reference, with its parameter name; a socket credential by name', () => {
  const header = definition({
    endpoint: { url: 'https://h/', credential: { name: 'key', as: 'header', param: 'X-Key' } },
  } as Partial<ConnectorProviderDefinition>);
  assert.deepEqual(endpointCredential(header), { key: 'x.key', as: 'header', name: 'X-Key' });
  const bearer = definition({
    endpoint: { url: 'https://h/', credential: { name: 'key', as: 'bearer' } },
  } as Partial<ConnectorProviderDefinition>);
  assert.deepEqual(endpointCredential(bearer), { key: 'x.key', as: 'bearer' });
  const undeclared = definition({
    endpoint: { url: 'https://h/', credential: { name: 'other', as: 'bearer' } },
  } as Partial<ConnectorProviderDefinition>);
  assert.equal(endpointCredential(undeclared), undefined);
  assert.equal(endpointCredential(definition({})), undefined);
  assert.equal(credentialRef(header, 'key'), 'x.key');
  assert.equal(credentialRef(header, 'other'), undefined);
  assert.equal(credentialRef(header, undefined), undefined);
});

test('reconnect: from two seconds, doubling, never above a minute', () => {
  let ms = RECONNECT_MIN_MS;
  const waits: number[] = [];
  for (let i = 0; i < 7; i++) {
    waits.push(ms);
    ms = nextRetryMs(ms);
  }
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  assert.equal(RECONNECT_MAX_MS, 60_000);
});

test('json: plain objects only; numbers and numeric strings, finite', () => {
  assert.equal(isPlainObject({}), true);
  for (const v of [null, [], 'a', 1, undefined]) assert.equal(isPlainObject(v), false);
  assert.equal(finiteNumber(3), 3);
  assert.equal(finiteNumber(' 12.5 '), 12.5);
  for (const v of ['', ' ', 'x', Number.NaN, Infinity, null, true, {}]) assert.equal(finiteNumber(v), undefined);
});

test('mapping: origin, one observation per object, the rejected line and the health message', () => {
  assert.equal(responseOrigin({ stale: false, fromCache: false }), 'live');
  assert.equal(responseOrigin({ stale: true, fromCache: false }), 'cached');
  assert.equal(responseOrigin({ stale: false, fromCache: true }), 'cached');
  const obs = (id: string, externalId?: string) => ({ id, ...(externalId ? { externalId } : {}) }) as Observation;
  const seen = new Set<string>(['a']);
  const into: Observation[] = [];
  assert.deepEqual(addUnseen([obs('1', 'a'), obs('2', 'b'), obs('3', 'b'), obs('4')], seen, into), {
    added: 2,
    repeated: 2,
  });
  assert.deepEqual(
    into.map((o) => o.id),
    ['2', '4'],
  );
  assert.equal(rejectedMessage(3), '3 record(s) rejected by the mapping on the last fetch');
  assert.equal(rejectedMessage(3, 2), '3 record(s) rejected by the mapping on the last fetch; 2 filtered out');
  const lines: Array<[string, unknown]> = [];
  const logger = { warn: (m: string, d: unknown) => lines.push([m, d]) } as unknown as Parameters<
    typeof warnRejected
  >[0];
  warnRejected(logger, []);
  warnRejected(logger, [{ reason: 'r1' }, { reason: 'r2' }, { reason: 'r3' }, { reason: 'r4' }]);
  assert.deepEqual(lines, [['rejected records', { count: 4, sample: ['r1', 'r2', 'r3'] }]]);
});
