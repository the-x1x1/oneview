import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DARK_THEME, densityColor, hexToRgba, resolveStyle, rgbaToCss, themeEntry } from './theme.js';

test('theme: class lookup walks to the parent class and falls back', () => {
  assert.equal(themeEntry('earthquake.shallow').color, '#f97316');
  assert.equal(
    themeEntry('aircraft.cluster').color,
    DARK_THEME.entries['aircraft']!.color,
    'cluster inherits the domain colour',
  );
  assert.equal(themeEntry('fire.density').color, DARK_THEME.entries['fire']!.color);
  assert.equal(themeEntry('nonsense.deep.class'), DARK_THEME.fallback);
});

test('theme: freshness dims STALE, selected/hovered add outlines and emphasis', () => {
  const live = resolveStyle({ styleClass: 'aircraft', freshness: 'LIVE' });
  const stale = resolveStyle({ styleClass: 'aircraft', freshness: 'STALE' });
  assert.equal(live.opacity, 1);
  assert.equal(stale.opacity, 0.5);
  assert.ok(stale.color.a < live.color.a);
  // Desaturated: channels closer together than the live colour.
  const spread = (c: { r: number; g: number; b: number }) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  assert.ok(spread(stale.color) < spread(live.color));

  const selected = resolveStyle({ styleClass: 'aircraft', selected: true, size: 10 });
  assert.equal(selected.outlineWidthPx, 2);
  assert.deepEqual(selected.outlineColor, hexToRgba('#ffffff', 1));
  assert.equal(selected.sizePx, 12.5);
  const hovered = resolveStyle({ styleClass: 'aircraft', hovered: true, size: 10 });
  assert.equal(hovered.outlineWidthPx, 1.5);
  assert.equal(hovered.sizePx, 11);
});

test('theme: explicit colour override, icons, cluster disc and density alpha ramp', () => {
  const custom = resolveStyle({ styleClass: 'vessel', color: '#112233', icon: 'vessel', rotationDegrees: 45 });
  assert.deepEqual(custom.color, hexToRgba('#112233', 1));
  assert.equal(custom.icon, 'vessel');
  assert.equal(custom.rotationDegrees, 45);
  assert.equal(resolveStyle({ styleClass: 'vessel.cluster' }).icon, 'cluster');
  const dens = resolveStyle({ styleClass: 'fire.density' });
  assert.ok(densityColor(dens, 1).a > densityColor(dens, 0).a);
  assert.equal(rgbaToCss({ r: 1, g: 0, b: 0, a: 0.5 }), 'rgba(255,0,0,0.500)');
  assert.deepEqual(hexToRgba('not-a-colour'), { r: 0.6, g: 0.6, b: 0.6, a: 1 });
});
