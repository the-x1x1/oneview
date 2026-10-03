import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelsField } from './perf-fields.js';

test('modelsField: the model counts in one short field; nothing in 2D', () => {
  assert.equal(modelsField(undefined), '');
  const base = { enabled: true, scanned: 12, near: 4, assigned: 4, drawn: 3, instances: 5, failed: [] };
  assert.equal(modelsField(base), 'on s12 n4 a4 d3 i5');
  assert.equal(modelsField({ ...base, enabled: false, failed: ['ship', 'uav'] }), 'off s12 n4 a4 d3 i5 fail:ship,uav');
});
