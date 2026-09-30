import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken } from './token.js';

test('generateToken: 32 random bytes as 43 base64url characters, a new one each time', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(
    generateToken((bytes) => bytes.fill(0xff)),
    '__________________________________________8',
    'the URL-safe alphabet, no padding',
  );
});
