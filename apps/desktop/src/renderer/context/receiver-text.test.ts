import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownFixText, receiverText } from './receiver-text.js';

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

test('ownFixText: this node only; the age worked out now, so an old fix reads STALE', () => {
  const at = Date.parse('2026-10-08T20:00:00Z');
  const props = {
    thisNode: true,
    ownFix: { kind: 'gps', fixAt: '2026-10-08T20:00:00.000Z', fixType: '3D', satellites: 8, accuracyM: 3.6 },
  };
  assert.equal(ownFixText(props, at + 40_000), "This computer's GPS: fix (3D, 8 satellites) 40 s old, ±3.6 m");
  assert.equal(
    ownFixText(props, at + 20 * 60_000),
    "This computer's GPS: STALE fix (3D, 8 satellites) 20 min old, ±3.6 m",
  );
  assert.equal(
    ownFixText({ thisNode: true, ownFix: { kind: 'set-by-hand' } }, at),
    'Fixed position set on the node (not GPS)',
  );
  assert.equal(ownFixText({ ownFix: props.ownFix }, at), undefined, 'not this node');
  for (const ownFix of [undefined, null, 'gps', [1], { kind: 'other' }])
    assert.equal(
      ownFixText({ thisNode: true, ...(ownFix === undefined ? {} : { ownFix: ownFix as never }) }, at),
      undefined,
    );
  assert.equal(ownFixText({ thisNode: true, ownFix: { kind: 'gps' } }, at), "This computer's GPS: STALE fix");
  // Dated ahead of this computer's clock: no age is claimed.
  for (const p of [
    { ...props, ownFix: { ...props.ownFix, clockAhead: true } },
    { ...props, ownFix: { ...props.ownFix, fixAt: '2026-10-08T21:00:00.000Z' } },
  ])
    assert.equal(
      ownFixText(p, at),
      "This computer's GPS: fix of unknown age (3D, 8 satellites) — its time is ahead of this computer's clock, ±3.6 m",
    );
  assert.equal(ownFixText({ thisNode: false, ownFix: null }, at), undefined, 'a node that is no longer this one');
});
