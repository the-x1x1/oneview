import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Accessibility (roadmap 1.0): the design tokens meet WCAG AA contrast (4.5:1) where they
 * are drawn as text. Read from tokens.css itself, so a colour changed there is checked here.
 */
// Here rather than beside tokens.css: packages/ui may not import node:fs, even in a test.
const css = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'ui', 'src', 'tokens.css'),
  'utf8',
);
const tokens = new Map([...css.matchAll(/--(wv-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1]!, m[2]!]));

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const mix = (c: Rgb, bg: Rgb, p: number): Rgb => c.map((v, i) => v * p + bg[i]! * (1 - p)) as Rgb;
const get = (name: string) => {
  const v = tokens.get(name);
  assert.ok(v, `token --${name} missing from tokens.css`);
  return rgb(v);
};

const SURFACES = ['wv-bg', 'wv-surface-1', 'wv-surface-2', 'wv-surface-3'];
const AA = 4.5;

test('contrast: the WCAG formula gives the reference values', () => {
  assert.equal(Math.round(contrast([0, 0, 0], [1, 1, 1]) * 100) / 100, 21);
  assert.equal(contrast([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), 1);
});

test('every text token is AA on the background, every surface and a hovered row', () => {
  const failures: string[] = [];
  for (const text of ['wv-text-primary', 'wv-text-secondary', 'wv-text-muted', 'wv-text-link', 'wv-accent'])
    for (const bg of [...SURFACES, 'wv-surface-hover']) {
      const r = contrast(get(text), get(bg));
      if (r < AA) failures.push(`${text} on ${bg}: ${r.toFixed(2)}`);
    }
  assert.deepEqual(failures, []);
});

test('every badge colour is AA as text on its own 12% tint, over every surface', () => {
  const badge = [...tokens.keys()].filter((k) =>
    /^wv-(fresh|conn|status|sev|conf)-|^wv-(danger|warning|success|recorded)$/.test(k),
  );
  assert.ok(badge.length >= 30, `only ${badge.length} badge tokens found`);
  const failures: string[] = [];
  for (const k of badge)
    for (const s of SURFACES) {
      const c = get(k);
      const r = contrast(c, mix(c, get(s), 0.12));
      if (r < AA) failures.push(`${k} on ${s}: ${r.toFixed(2)}`);
    }
  assert.deepEqual(failures, []);
});
