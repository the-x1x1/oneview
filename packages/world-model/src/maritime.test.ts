import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MID_ALLOCATIONS, mmsiFlag } from './maritime.js';

test('mmsiFlag: a ship station — the first three digits are the flag', () => {
  assert.deepEqual(mmsiFlag('366123456'), { kind: 'ship', mid: '366', country: 'United States' });
  assert.deepEqual(mmsiFlag('353000001'), { kind: 'ship', mid: '353', country: 'Panama' });
  assert.deepEqual(mmsiFlag('636012345'), { kind: 'ship', mid: '636', country: 'Liberia' });
  assert.deepEqual(mmsiFlag('538001234'), { kind: 'ship', mid: '538', country: 'Marshall Islands' });
  assert.deepEqual(mmsiFlag(244660123), { kind: 'ship', mid: '244', country: 'Netherlands' });
  assert.deepEqual(mmsiFlag('477000001'), { kind: 'ship', mid: '477', country: 'China (Hong Kong)' });
});

test('mmsiFlag: the other station formats put the MID elsewhere', () => {
  assert.deepEqual(mmsiFlag('002320001'), { kind: 'coast-station', mid: '232', country: 'United Kingdom' });
  assert.deepEqual(mmsiFlag('023200001'), { kind: 'group', mid: '232', country: 'United Kingdom' });
  assert.deepEqual(mmsiFlag('111232001'), { kind: 'sar-aircraft', mid: '232', country: 'United Kingdom' });
  assert.deepEqual(mmsiFlag('992351234'), { kind: 'aid-to-navigation', mid: '235', country: 'United Kingdom' });
  assert.deepEqual(mmsiFlag('982351234'), { kind: 'associated-craft', mid: '235', country: 'United Kingdom' });
  assert.deepEqual(mmsiFlag('823512345'), { kind: 'handheld', mid: '235', country: 'United Kingdom' });
  assert.deepEqual(mmsiFlag('970123456'), { kind: 'emergency-device' });
  assert.deepEqual(mmsiFlag('972123456'), { kind: 'emergency-device' });
});

test('mmsiFlag: an unallocated MID keeps its digits and names no country; nonsense is nothing', () => {
  assert.deepEqual(mmsiFlag('200123456'), { kind: 'ship', mid: '200' });
  assert.equal(mmsiFlag('12345'), undefined);
  assert.equal(mmsiFlag('000000000'), undefined);
  assert.equal(mmsiFlag('12345678a'), undefined);
  assert.equal(mmsiFlag('123456789'), undefined, 'no station kind starts with 1 but 111');
});

test('MID table: three-digit keys in the 2xx–7xx blocks, names present', () => {
  const keys = Object.keys(MID_ALLOCATIONS);
  assert.ok(keys.length > 280, `${keys.length} MIDs`);
  for (const k of keys) {
    assert.match(k, /^[2-7]\d\d$/);
    assert.ok(MID_ALLOCATIONS[k]!.length > 2);
  }
});
