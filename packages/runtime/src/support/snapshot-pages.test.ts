import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { SnapshotPages } from './snapshot-pages.js';

const objs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `o${i}` }) as unknown as WorldObject);

test('snapshot pages: small snapshots are whole; large ones page in order to the end', () => {
  let now = 0;
  let seq = 0;
  const pages = new SnapshotPages(
    () => now,
    60_000,
    () => `t${++seq}`,
  );
  assert.deepEqual(pages.start('c', objs(3), 5), { first: objs(3) });
  assert.deepEqual(pages.start('c', objs(3), undefined), { first: objs(3) }, 'no page size: whole');
  const r = pages.start('c', objs(12), 5);
  assert.equal(r.first.length, 5);
  assert.deepEqual(r.more, { token: 't1', remaining: 7 });
  const p2 = pages.next('c', 't1')!;
  assert.deepEqual(
    p2.page.map((o) => o.id),
    ['o5', 'o6', 'o7', 'o8', 'o9'],
  );
  assert.equal(p2.done, false);
  const p3 = pages.next('c', 't1')!;
  assert.deepEqual(
    p3.page.map((o) => o.id),
    ['o10', 'o11'],
  );
  assert.equal(p3.done, true);
  assert.equal(pages.next('c', 't1'), undefined, 'a finished snapshot has no more pages');
  assert.equal(pages.size, 0);
});

test('snapshot pages: a new subscription replaces the old; other clients and strangers get nothing; idle sessions expire', () => {
  let now = 0;
  let seq = 0;
  const pages = new SnapshotPages(
    () => now,
    60_000,
    () => `t${++seq}`,
  );
  pages.start('a', objs(10), 4);
  pages.start('b', objs(10), 4);
  assert.equal(pages.next('b', 't1'), undefined, 'a token is its own client’s');
  pages.start('a', objs(10), 4); // t3 replaces t1
  assert.equal(pages.next('a', 't1'), undefined);
  assert.ok(pages.next('a', 't3'));
  now += 59_000;
  assert.ok(pages.next('a', 't3'), 'fetching keeps a session alive');
  now += 61_000;
  assert.equal(pages.next('b', 't2'), undefined, 'idle past a minute: gone');
  assert.equal(pages.next('a', 't3'), undefined);
});
