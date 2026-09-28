import type { VisualStyleId } from '@worldview/render-core';

/**
 * The visual styles in 2D (render-core visual-styles.ts). MapLibre has no post-process
 * pass to hook into, so each style is two things on the renderer's pane, both drawn by the
 * browser's compositor rather than by the map:
 *
 * - an **SVG filter** on the map canvas for the colour: a luminance matrix and a
 *   component-transfer gradient map — the iron palette for thermal, the green phosphor
 *   curve for night vision, an S-curve for noir, the channels read a pixel apart for the CRT;
 * - a **CSS overlay** above it (`pointer-events: none`) for what sits on the glass: scanlines,
 *   the CRT's aperture grille, the tube's round field of view, a vignette, fixed grain.
 *
 * Both are static, like the globe's: nothing here animates, and the map redraws exactly when
 * it would have anyway. What 2D cannot do is bend the picture (the globe's CRT has barrel
 * distortion); the CRT's curved glass is suggested by rounded, shadowed corners instead.
 */
export interface FilterPrimitive {
  tag:
    | 'feColorMatrix'
    | 'feComponentTransfer'
    | 'feFuncR'
    | 'feFuncG'
    | 'feFuncB'
    | 'feGaussianBlur'
    | 'feOffset'
    | 'feComposite';
  attrs: Readonly<Record<string, string>>;
  children?: readonly FilterPrimitive[];
}

export interface VisualStyle2DSpec {
  /** Filter primitives on the map canvas, in order; null for none. */
  filter: readonly FilterPrimitive[] | null;
  /** Inline CSS for the overlay above the map; null for none. */
  overlay: Readonly<Record<string, string>> | null;
}

/** Rec. 709 luminance weights, as the globe's `czm_luminance`. */
const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** A colour-matrix row taking luminance × `gain` plus `offset` into one channel. */
function lumaRow(gain: number, offset = 0): string {
  return `${LUMA.map((w) => round(w * gain)).join(' ')} 0 ${round(offset)}`;
}
function round(n: number): string {
  return String(Math.round(n * 10_000) / 10_000);
}
const ALPHA_ROW = '0 0 0 1 0';

const matrix = (rows: string[], extra: Record<string, string> = {}): FilterPrimitive => ({
  tag: 'feColorMatrix',
  attrs: { type: 'matrix', values: rows.join('  '), ...extra },
});
const transfer = (
  r: Record<string, string>,
  g: Record<string, string>,
  b: Record<string, string>,
): FilterPrimitive => ({
  tag: 'feComponentTransfer',
  attrs: {},
  children: [
    { tag: 'feFuncR', attrs: r },
    { tag: 'feFuncG', attrs: g },
    { tag: 'feFuncB', attrs: b },
  ],
});

/**
 * Fine fixed grain as a tiled image: fractal noise at one octave, rendered once by the browser
 * and repeated. Same pattern every frame: grain that holds still.
 */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='1' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 1.6 -0.55'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E\")";

/** The iron palette (black, purple, magenta, red, orange, yellow, white) at seven even stops, per channel. */
export const IRON_TABLE = {
  r: [0, 0.22, 0.62, 0.9, 1, 1, 1],
  g: [0, 0, 0.02, 0.16, 0.56, 0.9, 1],
  b: [0.03, 0.45, 0.48, 0.1, 0, 0.3, 1],
} as const;

const table = (values: readonly number[]) => ({ type: 'table', tableValues: values.join(' ') });

const SPECS: Readonly<Record<VisualStyleId, VisualStyle2DSpec>> = Object.freeze({
  standard: { filter: null, overlay: null },
  'night-vision': {
    filter: [
      matrix([lumaRow(2.1 * 0.32, 0.01), lumaRow(2.1, 0.035), lumaRow(2.1 * 0.4, 0.015), ALPHA_ROW]),
      transfer(
        { type: 'gamma', amplitude: '1', exponent: '0.75', offset: '0' },
        { type: 'gamma', amplitude: '1', exponent: '0.75', offset: '0' },
        { type: 'gamma', amplitude: '1', exponent: '0.75', offset: '0' },
      ),
    ],
    overlay: {
      background: [
        GRAIN,
        'repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0.16) 0 1px, transparent 1px 3px)',
        'radial-gradient(circle closest-side at 50% 50%, transparent 92%, rgba(0, 6, 0, 0.8) 165%)',
      ].join(', '),
      opacity: '1',
    },
  },
  thermal: {
    filter: [
      { tag: 'feGaussianBlur', attrs: { stdDeviation: '0.6' } },
      matrix([lumaRow(1.3, -0.04), lumaRow(1.3, -0.04), lumaRow(1.3, -0.04), ALPHA_ROW]),
      transfer(table(IRON_TABLE.r), table(IRON_TABLE.g), table(IRON_TABLE.b)),
    ],
    overlay: null,
  },
  crt: {
    filter: [
      // The three channels a pixel apart: red one way, blue the other, green in place.
      matrix(['1 0 0 0 0', '0 0 0 0 0', '0 0 0 0 0', ALPHA_ROW], { in: 'SourceGraphic', result: 'red' }),
      { tag: 'feOffset', attrs: { in: 'red', dx: '1', dy: '0', result: 'redShifted' } },
      matrix(['0 0 0 0 0', '0 1 0 0 0', '0 0 0 0 0', ALPHA_ROW], { in: 'SourceGraphic', result: 'green' }),
      matrix(['0 0 0 0 0', '0 0 0 0 0', '0 0 1 0 0', ALPHA_ROW], { in: 'SourceGraphic', result: 'blue' }),
      { tag: 'feOffset', attrs: { in: 'blue', dx: '-1', dy: '0', result: 'blueShifted' } },
      {
        tag: 'feComposite',
        attrs: {
          in: 'redShifted',
          in2: 'green',
          operator: 'arithmetic',
          k1: '0',
          k2: '1',
          k3: '1',
          k4: '0',
          result: 'rg',
        },
      },
      {
        tag: 'feComposite',
        attrs: { in: 'rg', in2: 'blueShifted', operator: 'arithmetic', k1: '0', k2: '1', k3: '1', k4: '0' },
      },
      transfer(
        { type: 'linear', slope: '1.12', intercept: '-0.03' },
        { type: 'linear', slope: '1.14', intercept: '-0.03' },
        { type: 'linear', slope: '1.08', intercept: '-0.03' },
      ),
    ],
    overlay: {
      background: [
        'repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0.22) 0 1px, transparent 1px 2px)',
        'repeating-linear-gradient(to right, rgba(255, 40, 40, 0.07) 0 1px, rgba(40, 255, 40, 0.07) 1px 2px, rgba(40, 40, 255, 0.07) 2px 3px)',
        'radial-gradient(ellipse at 50% 50%, transparent 62%, rgba(0, 0, 0, 0.55) 100%)',
      ].join(', '),
      'border-radius': '22px',
      'box-shadow': 'inset 0 0 90px rgba(0, 0, 0, 0.75), 0 0 0 40px rgba(0, 0, 0, 1)',
    },
  },
  noir: {
    filter: [
      { tag: 'feColorMatrix', attrs: { type: 'saturate', values: '0' } },
      transfer(
        table([0, 0.02, 0.1, 0.3, 0.6, 0.85, 0.97, 1]),
        table([0, 0.02, 0.1, 0.3, 0.59, 0.84, 0.96, 0.985]),
        table([0, 0.02, 0.09, 0.28, 0.57, 0.81, 0.92, 0.95]),
      ),
    ],
    overlay: {
      background: [GRAIN, 'radial-gradient(ellipse at 50% 50%, transparent 45%, rgba(0, 0, 0, 0.6) 110%)'].join(', '),
    },
  },
});

export function visualStyle2D(id: VisualStyleId): VisualStyle2DSpec {
  return SPECS[id];
}

/** The slice of the DOM the applier touches: small enough to fake in a Node test. */
export interface StyleElement {
  setAttribute(name: string, value: string): void;
  appendChild(child: StyleElement): unknown;
  remove(): void;
  readonly style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown };
}
export interface StyleDocument {
  createElementNS(ns: string, tag: string): StyleElement;
  createElement(tag: string): StyleElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
let instances = 0;

/**
 * Puts a style on a map pane: the filter definition in a zero-size SVG inside the pane, the
 * filter on the canvas, the overlay above it. A change replaces all three; `standard`
 * removes them, leaving the pane exactly as it was.
 */
export class VisualStyle2D {
  private current: VisualStyleId = 'standard';
  private svg: StyleElement | undefined;
  private overlay: StyleElement | undefined;
  private readonly filterId = `wv-visual-style-${++instances}`;

  constructor(
    private readonly doc: StyleDocument,
    private readonly pane: StyleElement,
    private readonly canvas: StyleElement,
  ) {}

  get id(): VisualStyleId {
    return this.current;
  }

  set(id: VisualStyleId): void {
    if (id === this.current) return;
    this.current = id;
    this.clear();
    const spec = visualStyle2D(id);
    if (spec.filter) {
      const svg = this.doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.setProperty('position', 'absolute');
      const filter = this.doc.createElementNS(SVG_NS, 'filter');
      filter.setAttribute('id', this.filterId);
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      // The whole canvas, not the default 10 % margin round it that a blur would read from.
      for (const [k, v] of Object.entries({ x: '0', y: '0', width: '100%', height: '100%' })) filter.setAttribute(k, v);
      for (const p of spec.filter) filter.appendChild(this.primitive(p));
      svg.appendChild(filter);
      this.pane.appendChild(svg);
      this.svg = svg;
      this.canvas.style.setProperty('filter', `url(#${this.filterId})`);
    }
    if (spec.overlay) {
      const overlay = this.doc.createElement('div');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.setAttribute('class', `wv-visual-style wv-visual-style--${id}`);
      const base: Record<string, string> = {
        position: 'absolute',
        inset: '0',
        'pointer-events': 'none',
        'z-index': '1',
      };
      for (const [k, v] of Object.entries({ ...base, ...spec.overlay })) overlay.style.setProperty(k, v);
      this.pane.appendChild(overlay);
      this.overlay = overlay;
    }
  }

  dispose(): void {
    this.clear();
  }

  private clear(): void {
    this.canvas.style.removeProperty('filter');
    this.svg?.remove();
    this.svg = undefined;
    this.overlay?.remove();
    this.overlay = undefined;
  }

  private primitive(p: FilterPrimitive): StyleElement {
    const el = this.doc.createElementNS(SVG_NS, p.tag);
    for (const [k, v] of Object.entries(p.attrs)) el.setAttribute(k, v);
    for (const child of p.children ?? []) el.appendChild(this.primitive(child));
    return el;
  }
}
