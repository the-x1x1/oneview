import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('clean view (C) hides every bar: top bar, rails, context, timeline, map controls and the view bar', () => {
  const css = readFileSync(fileURLToPath(new URL('../../src/renderer/shell.css', import.meta.url)), 'utf8');
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

test('the HUD line sits below the map controls, and at the top in clean view', () => {
  const css = readFileSync(fileURLToPath(new URL('../../src/renderer/shell.css', import.meta.url)), 'utf8');
  const top = /\.wv-hud__top \{[^}]*top:\s*([^;]+);/.exec(css)?.[1] ?? '';
  assert.match(top, /28px/, 'clear of the 28 px controls row');
  assert.match(css, /\.wv-shell--clean \.wv-hud__top \{\s*top: var\(--wv-space-3\);/);
});
