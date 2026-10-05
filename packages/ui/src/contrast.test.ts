import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contrast of the colour tokens (roadmap 1.0, accessibility audit — the part a test can do):
 * every token text is drawn in, against every opaque surface it is drawn on, meets WCAG 2.x
 * AA for normal text (4.5:1); the primary button's dark label on the accent meets it too.
 * The visual styles (night vision, CRT, thermal, noir) change only the HUD's ink over the
 * map, whose background is imagery, not a token — that stays a check by eye.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, 'tokens.css'), 'utf8');
const root = css.slice(css.indexOf(':root {'), css.indexOf('@media'));
const tokens = new Map(
  [...root.matchAll(/--(wv-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!] as const),
);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a),
    lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const SURFACES = ['wv-bg', 'wv-surface-1', 'wv-surface-2', 'wv-surface-3', 'wv-surface-hover'];
const TEXT_PREFIXES = ['wv-text-', 'wv-fresh-', 'wv-conn-', 'wv-status-', 'wv-sev-', 'wv-conf-', 'wv-accent'];
const TEXT_SINGLES = ['wv-danger', 'wv-warning', 'wv-success', 'wv-recorded'];
const AA = 4.5;

test('contrast: the WCAG helper agrees with known pairs', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff') * 10) / 10, 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
});

test('contrast: every text colour token meets AA (4.5:1) on every surface', () => {
  const text = [...tokens.keys()].filter(
    (k) => k !== 'wv-text-inverse' && (TEXT_PREFIXES.some((p) => k.startsWith(p)) || TEXT_SINGLES.includes(k)),
  );
  assert.ok(text.length >= 30, `found ${text.length} text tokens`);
  for (const s of SURFACES) assert.ok(tokens.has(s), `surface ${s} is an opaque colour`);
  const failures: string[] = [];
  for (const t of text)
    for (const s of SURFACES) {
      const ratio = contrastRatio(tokens.get(t)!, tokens.get(s)!);
      if (ratio < AA) failures.push(`${t} on ${s}: ${ratio.toFixed(2)}`);
    }
  assert.deepEqual(failures, []);
});

test('contrast: the primary button label (text-inverse) meets AA on the accent, plain and hovered', () => {
  for (const bg of ['wv-accent', 'wv-accent-strong'])
    assert.ok(contrastRatio(tokens.get('wv-text-inverse')!, tokens.get(bg)!) >= AA, bg);
});
