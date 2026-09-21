import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextRegistry, contextRegistry, DEFAULT_SECTIONS, TYPE_SECTIONS } from './index.js';

test('registry composition: defaults + type sections at placement; same id overrides; unregister restores', () => {
  const r = new ContextRegistry();
  r.register('*', [{ id: 'identity', title: 'Identity', render: () => null }, { id: 'position', title: 'Position', render: () => null }, { id: 'related', title: 'Related', render: () => null }]);
  assert.deepEqual(r.sectionsFor('unknown-type').map((s) => s.id), ['identity', 'position', 'related']);

  const off = r.register('aircraft', [
    { id: 'aircraft', title: 'Aircraft', render: () => null },
    { id: 'weather-at', title: 'Weather', render: () => null, placement: { before: 'related' } },
    { id: 'extra', title: 'Extra', render: () => null, placement: 'end' },
    { id: 'position', title: 'Custom position', render: () => null },
  ]);
  const ids = r.sectionsFor('aircraft').map((s) => s.id);
  assert.deepEqual(ids, ['identity', 'aircraft', 'position', 'weather-at', 'related', 'extra']);
  assert.equal(r.sectionsFor('aircraft').find((s) => s.id === 'position')?.title, 'Custom position', 'type section overrides the default with the same id');
  assert.deepEqual(r.sectionsFor('vessel').map((s) => s.id), ['identity', 'position', 'related'], 'other types are untouched');
  assert.deepEqual(r.types(), ['aircraft']);
  off();
  assert.deepEqual(r.sectionsFor('aircraft').map((s) => s.id), ['identity', 'position', 'related']);
  // an unknown anchor appends rather than dropping the section
  r.register('vessel', [{ id: 'v', title: 'V', render: () => null, placement: { after: 'missing' } }]);
  assert.equal(r.sectionsFor('vessel').at(-1)?.id, 'v');
});

test('built-in registry: six defaults and one type section for each supported type', () => {
  assert.deepEqual(DEFAULT_SECTIONS.map((s) => s.id), ['identity', 'position', 'freshness', 'sources', 'history', 'related']);
  for (const { type } of TYPE_SECTIONS) {
    const ids = contextRegistry.sectionsFor(type).map((s) => s.id);
    assert.equal(ids[0], 'identity');
    assert.equal(ids[1], type, `${type} section directly after identity`);
    assert.equal(ids.length, DEFAULT_SECTIONS.length + 1);
  }
  assert.deepEqual(contextRegistry.types().sort(), ['aircraft', 'camera', 'earthquake', 'fire-detection', 'satellite', 'vessel', 'weather-alert']);
});
