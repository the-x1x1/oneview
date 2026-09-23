import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldChangedEvent, WorldClient } from '@worldview/ipc-contract';
import { bindClient, DELTA_GATHER_MS } from './sync.js';
import type { RootAction } from './types.js';

function fakeClient() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const client = {
    on: (channel: string, fn: (payload: unknown) => void) => {
      handlers.set(channel, fn);
      return () => handlers.delete(channel);
    },
    request: () => new Promise(() => undefined),
  } as unknown as WorldClient;
  return { client, emit: (channel: string, payload: unknown) => handlers.get(channel)?.(payload) };
}

const delta = (id: string): WorldChangedEvent =>
  ({
    added: [id],
    updated: [],
    removed: [],
    refreshed: [],
    objects: [{ id }],
    freshness: [],
    at: '2026-09-23T08:00:00.000Z',
  }) as unknown as WorldChangedEvent;

test('the parts of a big delta that arrive together are dispatched as one change', async () => {
  const { client, emit } = fakeClient();
  const actions: RootAction[] = [];
  const off = bindClient({
    client,
    dispatch: (a) => actions.push(a),
    getState: () => ({}) as never,
    now: () => 0,
  });
  emit('world.changed', delta('a'));
  emit('world.changed', delta('b'));
  emit('world.changed', delta('c'));
  assert.equal(actions.filter((a) => a.type.startsWith('world/changed')).length, 0, 'gathered first');
  await new Promise((r) => setTimeout(r, DELTA_GATHER_MS + 20));
  const world = actions.filter((a) => a.type.startsWith('world/changed'));
  assert.equal(world.length, 1);
  assert.equal(world[0]!.type, 'world/changedMany');
  assert.deepEqual(
    (world[0] as { changes: WorldChangedEvent[] }).changes.map((c) => c.added[0]),
    ['a', 'b', 'c'],
    'in the order they came',
  );
  emit('world.changed', delta('d'));
  await new Promise((r) => setTimeout(r, DELTA_GATHER_MS + 20));
  assert.equal(actions.filter((a) => a.type === 'world/changed').length, 1, 'a lone delta is dispatched as itself');
  emit('world.changed', delta('e'));
  off();
  await new Promise((r) => setTimeout(r, DELTA_GATHER_MS + 20));
  assert.equal(actions.filter((a) => a.type.startsWith('world/changed')).length, 2, 'nothing after dispose');
});
