import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryTrend, processLabel } from './diagnostics-dialog.js';

test('memory trend: the change in total over the samples kept, and the words for process kinds', () => {
  assert.equal(
    memoryTrend([
      { at: '2026-09-23T10:00:00.000Z', totalMB: 1400 },
      { at: '2026-09-23T11:00:00.000Z', totalMB: 1410 },
      { at: '2026-09-23T13:10:00.000Z', totalMB: 1442.4 },
    ]),
    '+42 MB over 3 h 10 min (3 samples)',
  );
  assert.equal(
    memoryTrend([
      { at: '2026-09-23T10:00:00.000Z', totalMB: 1400 },
      { at: '2026-09-23T10:20:00.000Z', totalMB: 1380 },
    ]),
    '−20 MB over 20 min (2 samples)',
  );
  assert.match(memoryTrend([{ at: '2026-09-23T10:00:00.000Z', totalMB: 1 }]), /one sample so far/);
  assert.equal(processLabel('Browser', 1), 'Main process');
  assert.equal(processLabel('Tab', 2), 'Pages (2)');
  assert.equal(processLabel('Utility', 3), 'Utility processes (3)');
});
