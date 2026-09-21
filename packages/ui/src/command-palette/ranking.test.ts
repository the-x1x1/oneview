import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, scoreMatch } from './ranking.js';
import { paletteItems, type PaletteCommand } from './command-palette.js';

test('scoreMatch orders exact > prefix > word-prefix > substring > keyword > subsequence > none', () => {
  assert.equal(scoreMatch('sources', 'Sources'), 100);
  assert.equal(scoreMatch('sou', 'Sources'), 80);
  assert.equal(scoreMatch('health', 'Source health'), 70);
  assert.equal(scoreMatch('urce', 'Sources'), 55);
  assert.equal(scoreMatch('provider', 'Sources', ['providers']), 45);
  assert.ok(scoreMatch('src', 'Sources') >= 20 && scoreMatch('src', 'Sources') < 40);
  assert.equal(scoreMatch('zzz', 'Sources'), 0);
  assert.equal(scoreMatch('', 'anything'), 1);
  assert.equal(scoreMatch('Ã', 'a'), 100, 'matching is accent-insensitive');
});

test('rank keeps original order for ties and applies boosts and limits', () => {
  const items = [
    { id: 'a', title: 'Open Settings' },
    { id: 'b', title: 'Open Sources' },
    { id: 'c', title: 'Open Diagnostics', boost: 10 },
    { id: 'd', title: 'Jump to live' },
  ];
  const r = rank('open', items, 2);
  assert.deepEqual(r.map((x) => x.item.id), ['c', 'a']);
  const all = rank('', items);
  assert.deepEqual(all.map((x) => x.item.id), ['c', 'a', 'b', 'd']);
});

test('paletteItems: unavailable commands are omitted, commands precede search results', () => {
  const commands: PaletteCommand[] = [
    { id: 'lens.aviation', title: 'Switch lens: Aviation', group: 'Lenses', icon: 'aircraft', run: () => {} },
    { id: 'zone.create', title: 'Create watch zone here', available: false, run: () => {} },
    { id: 'view.3d', title: 'Switch to 3D', shortcut: '3', run: () => {} },
  ];
  const items = paletteItems('', commands, [{ id: 'place:hnl', title: 'Honolulu', subtitle: 'Place' }]);
  assert.deepEqual(items.map((i) => i.id), ['cmd:lens.aviation', 'cmd:view.3d', 'place:hnl']);
  assert.equal(items[1]?.hint, '3');
  const filtered = paletteItems('avi', commands);
  assert.deepEqual(filtered.map((i) => i.id), ['cmd:lens.aviation']);
});
