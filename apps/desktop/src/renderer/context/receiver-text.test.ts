import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiverText } from './receiver-text.js';

test('receiverText: own receiver on 1090 MHz; anything else, nothing', () => {
  assert.equal(
    receiverText({
      receiver: { kind: 'own-receiver', frequencyMHz: 1090, decoder: 'readsb / dump1090 (aircraft.json)' },
    }),
    'Received here on 1090 MHz (readsb / dump1090 (aircraft.json))',
  );
  assert.equal(receiverText({ receiver: { kind: 'own-receiver' } }), 'Received here');
  for (const receiver of [undefined, null, 'x', [1], { kind: 'remote' }, { frequencyMHz: 1090 }])
    assert.equal(receiverText(receiver === undefined ? {} : { receiver: receiver as never }), undefined);
});
