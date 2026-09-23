import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldBridge } from '@worldview/ipc-contract';
import { responseToWire, toWire } from '../shared/event-wire.js';
import { wireClient } from './wire-client.js';
import { clearDeltaMarks, takeDecodeMax } from './map/delta-marks.js';

let respond: unknown = { ok: true };

function fakeBridge() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const requests: Array<{ channel: string; request: unknown }> = [];
  const bridge = {
    contractVersion: 7,
    platform: 'win32',
    request: async (channel: string, request: unknown) => {
      requests.push({ channel, request });
      return respond;
    },
    on: (event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  } as unknown as WorldBridge;
  return { bridge, listeners, requests };
}

test('wire client: events sent as JSON are parsed in the page; the rest pass through; requests are the bridge', async () => {
  clearDeltaMarks();
  const { bridge, listeners, requests } = fakeBridge();
  let t = 0;
  const client = wireClient(bridge, () => (t += 4));
  assert.equal(client.contractVersion, 7);

  const deltas: unknown[] = [];
  const off = client.on('world.changed', (d) => deltas.push(d));
  const delta = {
    added: ['a'],
    updated: [],
    removed: [],
    refreshed: [],
    at: 'x',
    objectCount: 1,
    objects: [],
    freshness: [],
  };
  listeners.get('world.changed')!(toWire('world.changed', delta));
  assert.deepEqual(deltas, [delta]);
  assert.equal(takeDecodeMax(), 4, 'the parse is timed for the perf log');
  assert.equal(takeDecodeMax(), 0, 'once per window');

  const settings: unknown[] = [];
  client.on('settings.changed', (s) => settings.push(s));
  const payload = { textScale: 1 };
  listeners.get('settings.changed')!(payload);
  assert.equal(settings[0], payload, 'not encoded, not touched');
  assert.equal(takeDecodeMax(), 0, 'and nothing was parsed');

  await client.request('world.snapshot' as never, { limit: 1 } as never);
  assert.deepEqual(requests, [{ channel: 'world.snapshot', request: { limit: 1 } }]);
  // A response sent as JSON is parsed here too.
  respond = responseToWire('world.subscribe', { snapshot: [{ id: 'a' }], count: 1 });
  assert.deepEqual(await client.request('world.subscribe', {}), { snapshot: [{ id: 'a' }], count: 1 });
  assert.ok(takeDecodeMax() > 0);
  off();
  assert.equal(listeners.has('world.changed'), false, 'unsubscribing reaches the bridge');
});
