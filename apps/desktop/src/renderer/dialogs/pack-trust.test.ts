import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatKeyId, installLine, packFreshness, signatureText } from './pack-trust.js';

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

test('the install line says what came of it: installed, refused and why, or nothing for a cancel', () => {
  assert.equal(installLine(null), undefined);
  assert.equal(installLine({ installed: null, issues: [] }), undefined, 'cancelled: nothing to say');
  assert.deepEqual(installLine({ installed: 'Hawaii', issues: [] }), { text: 'Installed Hawaii', tone: 'ok' });
  const refused = installLine({
    installed: null,
    issues: ['pack requires app version >= 0.1.0 (this app is 0.1.0-rc.3)'],
  });
  assert.equal(refused?.tone, 'bad');
  assert.match(refused?.text ?? '', /^Not installed — pack requires app version/);
});

test('a pack says how old it is and whether its publisher still stands by it', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  assert.equal(packFreshness({}, now), undefined, 'an older host sends no dates');
  assert.deepEqual(packFreshness({ createdAt: '2026-09-21T12:00:00Z' }, now), { text: 'built 2d ago', tone: 'muted' });
  assert.deepEqual(packFreshness({ createdAt: '2026-09-21T12:00:00Z', expiresAt: '2026-10-21T00:00:00Z' }, now), {
    text: 'built 2d ago · good until 2026-10-21',
    tone: 'muted',
  });
  const old = packFreshness({ createdAt: '2025-09-01T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z' }, now);
  assert.equal(old?.tone, 'bad');
  assert.match(old?.text ?? '', /out of date since/);
});
