import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pastShownAtMs } from './shown-time.js';

test('the map shows now when live or paused (the live world keeps coming), the cursor when replaying', () => {
  assert.equal(pastShownAtMs({ mode: 'LIVE', cursorMs: 5 }), undefined);
  assert.equal(pastShownAtMs({ mode: 'PAUSED', cursorMs: 5 }), undefined);
  assert.equal(pastShownAtMs({ mode: 'REPLAY', cursorMs: 5 }), 5);
  assert.equal(pastShownAtMs({ mode: 'HISTORICAL', cursorMs: 7 }), 7);
});
