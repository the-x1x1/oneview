import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatKeyId, signatureText } from './pack-trust.js';

test('a pack’s signature line says who signed it — and says so plainly when nobody the operator knows did', () => {
  assert.equal(formatKeyId('68d5ac8c8ed996b4'), '68d5 ac8c 8ed9 96b4');
  assert.deepEqual(signatureText({ status: 'trusted', keyId: '68d5ac8c8ed996b4', publisher: 'Alice Maps' }), {
    text: 'Signed by Alice Maps',
    tone: 'ok',
  });
  const unknown = signatureText({ status: 'signed', keyId: '68d5ac8c8ed996b4' });
  assert.match(unknown.text, /68d5 ac8c 8ed9 96b4 — not one of your publishers/);
  assert.equal(unknown.tone, 'muted', 'a valid signature by an unknown key is not good news');
  assert.equal(signatureText({ status: 'invalid', reason: 'changed after signing' }).tone, 'bad');
  assert.match(signatureText(undefined).text, /^Not signed/, 'an older host reports no signature: unsigned');
  assert.match(
    signatureText({ status: 'unchecked', keyId: 'x', reason: 'no Ed25519' }).text,
    /not checked: no Ed25519/,
  );
});
