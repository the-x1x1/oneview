import type { RenderStyle } from './contract.js';

/**
 * Theme: semantic style class → colour/size for the dark UI. Shared by both
 * adapters so a WorldObject looks the same on the globe and on the flat map.
 * Pure: no DOM, no renderer types. Cesium converts `RgbaColor` to `Cesium.Color`;
 * MapLibre uses the CSS string.
 */
export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ThemeEntry {
  /** Base colour (hex, #rrggbb). */
  color: string;
  /** Default point/marker size in px when the feature carries none. */
  sizePx: number;
  /** Outline used for markers/points (hex). */
  outline: string;
  /** Label text colour (hex). */
  label: string;
}

export interface Theme {
  name: 'dark' | 'light';
  entries: Record<string, ThemeEntry>;
  /** Fallback when no class matches. */
  fallback: ThemeEntry;
  selectedOutline: string;
  hoveredOutline: string;
  labelOutline: string;
  labelFontPx: number;
}

const dark = (color: string, sizePx = 6, outline = '#0b0f14', label = '#e6edf3'): ThemeEntry => ({
  color,
  sizePx,
  outline,
  label,
});

/**
 * Restrained technical palette on a near-black map: one hue per domain, no neon.
 *
 * Aircraft, vessels and satellites share the overview, so their hues sit far apart and are
 * saturated enough to hold up on satellite imagery as well as on space: pastel sky-blue
 * aircraft beside pastel violet satellites read as one grey haze on a bright desert.
 */
export const DARK_THEME: Theme = {
  name: 'dark',
  entries: {
    aircraft: dark('#38bdf8', 6),
    vessel: dark('#2dd4bf', 6),
    satellite: dark('#a78bfa', 4),
    earthquake: dark('#fb923c', 8),
    'earthquake.shallow': dark('#f97316', 8),
    'earthquake.intermediate': dark('#fbbf24', 8),
    'earthquake.deep': dark('#a78bfa', 8),
    fire: dark('#f87171', 5),
    'weather-alert': dark('#fde047', 8),
    'weather-station': dark('#93c5fd', 5),
    camera: dark('#a3e635', 5),
    transit: dark('#f9a8d4', 5),
    infrastructure: dark('#94a3b8', 5),
    launch: dark('#fdba74', 8),
    sensor: dark('#86efac', 5),
    place: dark('#cbd5e1', 5),
    trail: dark('#e2e8f0', 2),
    event: dark('#f472b6', 8),
    'event.earthquake': dark('#fb923c', 8),
    'event.wildfire-cluster': dark('#f87171', 8),
    'event.weather-alert': dark('#fde047', 8),
    'event.launch': dark('#fdba74', 8),
    'event.satellite-decay': dark('#c4b5fd', 8),
  },
  fallback: dark('#9ca3af', 5),
  selectedOutline: '#ffffff',
  hoveredOutline: '#e5e7eb',
  labelOutline: '#0b0f14',
  labelFontPx: 12,
};

export interface ResolvedStyle {
  /** Fill colour with freshness/opacity applied. */
  color: RgbaColor;
  colorCss: string;
  outlineColor: RgbaColor;
  outlineWidthPx: number;
  /** Point/marker diameter or line width in px. */
  sizePx: number;
  opacity: number;
  labelColor: RgbaColor;
  labelOutlineColor: RgbaColor;
  labelFontPx: number;
  /** Fill alpha for area features (polygon/circle/density). */
  fillAlpha: number;
  /** Icon id when the feature renders as a sprite; cluster discs use 'cluster'. */
  icon?: string;
  rotationDegrees: number;
  /** Multiplier applied to size for emphasis. */
  emphasis: number;
}

export function hexToRgba(hex: string, alpha = 1): RgbaColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0.6, g: 0.6, b: 0.6, a: alpha };
  const v = parseInt(m[1]!, 16);
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a: alpha };
}

export function rgbaToCss(c: RgbaColor): string {
  const ch = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return `rgba(${ch(c.r)},${ch(c.g)},${ch(c.b)},${Math.max(0, Math.min(1, c.a)).toFixed(3)})`;
}

/** Desaturate towards grey by `t` (0 = unchanged, 1 = grey). */
export function desaturate(c: RgbaColor, t: number): RgbaColor {
  const l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return { r: c.r + (l - c.r) * t, g: c.g + (l - c.g) * t, b: c.b + (l - c.b) * t, a: c.a };
}

/**
 * Resolve a style class: exact match, then the parent class (drop the last
 * `.suffix`), then fallback. `x.cluster` and `x.density` inherit `x`'s colour.
 */
export function themeEntry(styleClass: string, theme: Theme = DARK_THEME): ThemeEntry {
  let key = styleClass;
  for (;;) {
    const hit = theme.entries[key];
    if (hit) return hit;
    const dot = key.lastIndexOf('.');
    if (dot < 0) return theme.fallback;
    key = key.slice(0, dot);
  }
}

const FRESHNESS_ALPHA: Record<NonNullable<RenderStyle['freshness']>, number> = {
  LIVE: 1,
  RECENT: 0.9,
  STALE: 0.5,
  HISTORICAL: 0.7,
  UNKNOWN: 0.8,
};
const FRESHNESS_DESATURATE: Record<NonNullable<RenderStyle['freshness']>, number> = {
  LIVE: 0,
  RECENT: 0.1,
  STALE: 0.6,
  HISTORICAL: 0.3,
  UNKNOWN: 0.3,
};

export function resolveStyle(style: RenderStyle, theme: Theme = DARK_THEME): ResolvedStyle {
  const entry = themeEntry(style.styleClass, theme);
  const isCluster = style.styleClass.endsWith('.cluster');
  const isDensity = style.styleClass.endsWith('.density');
  const freshness = style.freshness ?? 'LIVE';
  const opacity = Math.max(0, Math.min(1, (style.opacity ?? 1) * FRESHNESS_ALPHA[freshness]));
  const base = desaturate(hexToRgba(style.color ?? entry.color, opacity), FRESHNESS_DESATURATE[freshness]);
  const emphasis = style.selected ? 1.25 : style.hovered ? 1.1 : 1;
  const sizePx = (style.size ?? entry.sizePx) * emphasis;
  const outlineHex = style.selected ? theme.selectedOutline : style.hovered ? theme.hoveredOutline : entry.outline;
  const outlineWidthPx = style.selected ? 2 : style.hovered ? 1.5 : isCluster ? 1.5 : 1;
  const resolved: ResolvedStyle = {
    color: base,
    colorCss: rgbaToCss(base),
    outlineColor: hexToRgba(outlineHex, Math.min(1, opacity + 0.2)),
    outlineWidthPx,
    sizePx,
    opacity,
    labelColor: hexToRgba(entry.label, Math.min(1, opacity + 0.1)),
    labelOutlineColor: hexToRgba(theme.labelOutline, 0.9),
    labelFontPx: theme.labelFontPx,
    fillAlpha: isDensity ? 0.15 + 0.55 * opacity : 0.25 * opacity,
    rotationDegrees: style.rotationDegrees ?? 0,
    emphasis,
  };
  if (isCluster) resolved.icon = 'cluster';
  else if (style.icon) resolved.icon = style.icon;
  return resolved;
}

/** Colour for a density cell at a given normalised intensity (0..1): alpha ramps, hue stays. */
export function densityColor(resolved: ResolvedStyle, intensity: number): RgbaColor {
  const t = Math.max(0, Math.min(1, intensity));
  return { ...resolved.color, a: 0.12 + 0.6 * t * resolved.opacity };
}
