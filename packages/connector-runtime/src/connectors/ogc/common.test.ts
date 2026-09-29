import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFadeBelow } from './common.js';

test('parseFadeBelow: "from,to" within 0–255, from below to', () => {
  assert.deepEqual(parseFadeBelow('110,170'), { from: 110, to: 170 });
  assert.deepEqual(parseFadeBelow(' 0 , 255 '), { from: 0, to: 255 });
  assert.equal(parseFadeBelow(undefined), undefined);
  for (const bad of ['170,110', '110', '110,300', 'a,b', '-1,20'])
    assert.equal(typeof parseFadeBelow(bad), 'string', bad);
});
