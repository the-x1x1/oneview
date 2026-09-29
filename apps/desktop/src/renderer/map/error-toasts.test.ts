import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorToastGate, errorToastKey } from './error-toasts.js';

test('tile failures of one layer are one kind of problem', () => {
  const a = 'AJAXError: Failed to fetch (0): wvwmts://gibs-goes-east-infrared%3Agoes-east%3A2026-09-29t00-20-00z/0/0/0';
  const b = 'AJAXError: Failed to fetch (0): wvwmts://gibs-goes-east-infrared%3Agoes-east%3A2026-09-29t00-30-00z/1/0/1';
  const c = 'AJAXError: Failed to fetch (0): wvwmts://gibs-himawari-infrared%3Ahimawari%3A2026-09-29t00-10-00z/0/0/0';
  assert.equal(errorToastKey(a), errorToastKey(b));
  assert.notEqual(errorToastKey(a), errorToastKey(c), 'another layer is told apart');
  assert.equal(
    errorToastKey('HTTP 404: https://tiles.example.invalid/a/3/2/1.png'),
    errorToastKey('HTTP 404: https://tiles.example.invalid/a/4/9/9.png'),
  );
});

test('ErrorToastGate: once per kind per quiet period', () => {
  const gate = new ErrorToastGate(1000);
  assert.equal(gate.allow('x 1/2/3', 0), true);
  assert.equal(gate.allow('x 4/5/6', 10), false);
  assert.equal(gate.allow('y', 20), true);
  assert.equal(gate.allow('x 7/8/9', 1500), true, 'again after the quiet period');
});
