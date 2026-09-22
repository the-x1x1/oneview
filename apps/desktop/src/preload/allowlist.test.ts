import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_CHANNELS, EVENT_CHANNELS } from '@worldview/ipc-contract';
import { isEventChannel, isPlainPayload, isRequestChannel, unwrapEnvelope, wireNameFor } from './allowlist.js';
import { IpcRequestError, okEnvelope, errorEnvelope } from '../shared/ipc-envelope.js';

test('preload allowlist: only catalogue channels get a wire name', () => {
  for (const c of REQUEST_CHANNELS) {
    assert.equal(isRequestChannel(c), true);
    assert.equal(wireNameFor('request', c), `worldview:${c}`);
  }
  for (const e of EVENT_CHANNELS) {
    assert.equal(isEventChannel(e), true);
    assert.equal(wireNameFor('event', e), `worldview:${e}`);
  }
  for (const bad of [
    'fs.readFile',
    'worldview:settings.get',
    '',
    'constructor',
    '__proto__',
    'settings.changed',
    42,
    null,
    undefined,
    {},
  ]) {
    assert.equal(isRequestChannel(bad), false, String(bad));
    assert.equal(wireNameFor('request', bad), undefined, String(bad));
  }
  assert.equal(isEventChannel('settings.get'), false, 'request names are not events');
  assert.equal(wireNameFor('event', 'world.query'), undefined);
});

test('preload allowlist: envelopes unwrap to values or structured errors; anything else is a protocol violation', () => {
  assert.deepEqual(unwrapEnvelope('settings.get', okEnvelope({ a: 1 })), { a: 1 });
  assert.throws(
    () => unwrapEnvelope('x', errorEnvelope({ code: 'DENIED', message: 'nope', channel: 'x' })),
    (e: IpcRequestError) =>
      e instanceof IpcRequestError && e.code === 'DENIED' && e.channel === 'x' && e.message === 'nope',
  );
  assert.throws(
    () => unwrapEnvelope('x', 'raw string'),
    (e: IpcRequestError) => e.code === 'INTERNAL',
  );
  assert.throws(
    () => unwrapEnvelope('x', undefined),
    (e: IpcRequestError) => e.code === 'INTERNAL',
  );
});

test('preload allowlist: only plain JSON payloads cross the bridge', () => {
  assert.equal(isPlainPayload(undefined), true);
  assert.equal(isPlainPayload({ a: [1, 'x', { b: null }] }), true);
  assert.equal(isPlainPayload(new Uint8Array(2)), true);
  assert.equal(isPlainPayload({ fn: () => 1 }), false);
  assert.equal(isPlainPayload(new Date()), false);
  assert.equal(isPlainPayload(Number.NaN), false);
  assert.equal(isPlainPayload(Symbol('x')), false);
  class Weird {
    x = 1;
  }
  assert.equal(isPlainPayload(new Weird()), false);
  const deep: Record<string, unknown> = {};
  let cur = deep;
  for (let i = 0; i < 70; i++) {
    const next: Record<string, unknown> = {};
    cur.n = next;
    cur = next;
  }
  assert.equal(isPlainPayload(deep), false, 'depth bound');
});
