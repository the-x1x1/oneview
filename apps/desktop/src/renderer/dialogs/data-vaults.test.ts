import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VaultHealthSummary } from '@worldview/ipc-contract';
import { vaultDetail, vaultStateText } from './data-vaults.js';

const base: VaultHealthSummary = {
  id: 'a'.repeat(32),
  label: 'Field SSD',
  path: '/media/op/FIELD/worldview',
  state: 'ready',
  message: '"Field SSD" is connected',
  freeBytes: 1.5 * 1024 ** 4,
  totalBytes: 2 * 1024 ** 4,
  checkedAt: '2026-10-08T12:00:00.000Z',
};

test('data vaults: every state reads as words, with a tone that is never green unless it can be written', () => {
  const states: VaultHealthSummary['state'][] = ['ready', 'read-only', 'low-space', 'absent', 'foreign', 'error'];
  for (const state of states) {
    const t = vaultStateText({ state });
    assert.ok(t.text.length > 0, state);
    assert.equal(t.tone === 'ok', state === 'ready', state);
  }
  assert.equal(vaultStateText({ state: 'absent' }).text, 'Not connected');
});

test('data vaults: a connected vault shows where it is, its packs and its room; an absent one why, and what is remembered', () => {
  const ready = vaultDetail(base, 3);
  assert.match(ready, /^\/media\/op\/FIELD\/worldview · 3 packs · /);
  assert.match(ready, /free of/);
  assert.doesNotMatch(ready, /is connected/, 'no message repeated for the good case');
  assert.match(vaultDetail({ ...base, state: 'low-space', message: 'nearly full' }, 1), /1 pack · .* — nearly full$/);
  const away = vaultDetail({ ...base, state: 'absent', message: '"Field SSD" is not connected' }, 2);
  assert.equal(away, '"Field SSD" is not connected · 2 packs remembered');
  const { freeBytes: _f, totalBytes: _t, ...noRoom } = base;
  assert.equal(vaultDetail(noRoom, 0), '/media/op/FIELD/worldview · 0 packs');
});
