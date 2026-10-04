import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('clean view (C) hides every bar: top bar, rails, context, timeline, map controls and the view bar', () => {
  const css = readFileSync(fileURLToPath(new URL('./shell.css', import.meta.url)), 'utf8');
  const rule = /((?:\.wv-shell--clean[^{,]*,\s*)*\.wv-shell--clean[^{,]*)\{\s*display:\s*none;/.exec(css);
  assert.ok(rule, 'a display:none rule for clean view');
  for (const part of [
    '.wv-topbar',
    '.wv-lensrail',
    '.wv-context',
    '.wv-timelinebar',
    '.wv-map__controls',
    '.wv-viewbar',
  ])
    assert.ok(rule[1]!.includes(part), `${part} is hidden in clean view`);
});
