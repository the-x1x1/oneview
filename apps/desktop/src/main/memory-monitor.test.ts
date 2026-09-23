import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_HISTORY, MemoryMonitor, summariseMetrics } from './memory-monitor.js';

const metrics = [
  { type: 'Browser', memory: { workingSetSize: 200 * 1024 } },
  { type: 'Tab', memory: { workingSetSize: 900 * 1024 } },
  { type: 'GPU', memory: { workingSetSize: 300 * 1024 } },
  { type: 'Utility', memory: { workingSetSize: 20 * 1024 } },
  { type: 'Utility', memory: { workingSetSize: 30 * 1024 } },
];

test('memory: megabytes per process kind, largest first, and the total', () => {
  const s = summariseMetrics(metrics, 150 * 1024 * 1024, '2026-09-23T16:00:00.000Z');
  assert.deepEqual(s.processes, [
    { type: 'Tab', count: 1, workingSetMB: 900 },
    { type: 'GPU', count: 1, workingSetMB: 300 },
    { type: 'Browser', count: 1, workingSetMB: 200 },
    { type: 'Utility', count: 2, workingSetMB: 50 },
  ]);
  assert.equal(s.totalMB, 1450);
  assert.equal(s.mainHeapMB, 150);
});

test('memory: samples are logged and kept for six hours; the snapshot reads the processes afresh', () => {
  let now = Date.parse('2026-09-23T10:00:00.000Z');
  let tab = 900 * 1024;
  const logged: Array<Record<string, number | string>> = [];
  const m = new MemoryMonitor({
    metrics: () => metrics.map((x) => (x.type === 'Tab' ? { ...x, memory: { workingSetSize: tab } } : x)),
    heapUsed: () => 100 * 1024 * 1024,
    now: () => now,
    log: (f) => logged.push(f),
  });
  for (let i = 0; i < MEMORY_HISTORY + 4; i++) {
    m.sample();
    now += 600_000;
    tab += 10 * 1024;
  }
  const snap = m.snapshot()!;
  assert.equal(snap.history.length, MEMORY_HISTORY, 'six hours at one sample per ten minutes');
  assert.ok(snap.history.at(-1)!.totalMB > snap.history[0]!.totalMB, 'a climb shows as one');
  assert.equal(logged.length, MEMORY_HISTORY + 4);
  assert.equal(logged[0]!['tabMB'], 900);
  assert.equal(snap.processes[0]!.type, 'Tab');
  const broken = new MemoryMonitor({
    metrics: () => {
      throw new Error('no');
    },
    heapUsed: () => 0,
    now: () => now,
  });
  broken.sample();
  assert.equal(broken.snapshot(), undefined, 'no sample, no snapshot');
});
