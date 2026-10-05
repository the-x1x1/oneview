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
  /**
   * Fill alpha for this class's areas when it is not the default 0.25. Footprints that tile
   * the world and overlap by design (imagery scenes) draw as outlines with a trace of fill:
   * at 0.25, a few dozen stacked Sentinel-2 scenes made an opaque veil that washed the
   * basemap out to white.
   */
  fillAlpha?: number;
  /**
   * Width in px of this class's area edges (a polygon's or circle's outline) when it should
   * stand out from the default hairline: a tornado warning is drawn with a bold red edge so it
   * reads at a glance among a dozen advisories. Absent: the renderers' default edge.
   */
  edgePx?: number;
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
    // Military transponders: amber against the sky-blue of everything else in the air.
    'aircraft.military': dark('#f59e0b', 6),
    vessel: dark('#2dd4bf', 6),
    'vessel.own': dark('#f472b6', 7),
    satellite: dark('#a78bfa', 4),
    // Satellites by what they are for (celestrak categories.ts). The violet stays for
    // communications and anything unknown; Starlink, thousands strong, is the quietest;
    // stations, the few everyone looks for, the brightest.
    'satellite.station': dark('#fde68a', 5),
    'satellite.starlink': dark('#8b90b8', 4),
    'satellite.comms': dark('#a78bfa', 4),
    'satellite.navigation': dark('#60a5fa', 4),
    'satellite.weather': dark('#67e8f9', 4),
    'satellite.earth-observation': dark('#86efac', 4),
    'satellite.science': dark('#f0abfc', 4),
    'satellite.military': dark('#fb7185', 4),
    'satellite.debris': dark('#71717a', 3),
    earthquake: dark('#fb923c', 8),
    'earthquake.shallow': dark('#f97316', 8),
    'earthquake.intermediate': dark('#fbbf24', 8),
    'earthquake.deep': dark('#a78bfa', 8),
    fire: dark('#f87171', 5),
    'weather-alert': dark('#fde047', 8),
    'weather-alert.minor': dark('#fde047', 8),
    'weather-alert.moderate': dark('#fb923c', 8),
    'weather-alert.severe': dark('#ef4444', 8),
    'weather-alert.extreme': dark('#d946ef', 9),
    // Warnings that need action now, by kind (presentation WEATHER_ALERT_SUFFIXES), in the
    // NWS's own hues where they read on a dark map, each edge bolder than an advisory's. A
    // tornado emergency or a PDS warning is the brightest thing on the map.
    'weather-alert.tornado-emergency': { ...dark('#ff00ff', 11), edgePx: 5, fillAlpha: 0.35 },
    'weather-alert.tornado-pds': { ...dark('#ff1a4b', 10), edgePx: 4.5, fillAlpha: 0.33 },
    'weather-alert.tornado-warning': { ...dark('#ff0000', 10), edgePx: 4, fillAlpha: 0.3 },
    'weather-alert.severe-thunderstorm-destructive': { ...dark('#ff7a00', 9), edgePx: 3.5 },
    'weather-alert.severe-thunderstorm-warning': { ...dark('#ffa500', 9), edgePx: 3 },
    'weather-alert.flash-flood-emergency': { ...dark('#00ffb3', 10), edgePx: 4, fillAlpha: 0.3 },
    'weather-alert.flash-flood-warning': { ...dark('#22e07a', 9), edgePx: 3 },
    'weather-alert.extreme-wind-warning': { ...dark('#ff8c00', 10), edgePx: 4 },
    'weather-alert.hurricane-warning': { ...dark('#dc143c', 10), edgePx: 3.5 },
    'weather-alert.storm-surge-warning': { ...dark('#b524f7', 9), edgePx: 3 },
    'weather-alert.tropical-storm-warning': { ...dark('#b22222', 9), edgePx: 2.5 },
    'weather-alert.hurricane-watch': { ...dark('#ff69b4', 8), edgePx: 2 },
    'weather-alert.tornado-watch': { ...dark('#ffff00', 8), edgePx: 2, fillAlpha: 0.12 },
    'weather-alert.severe-thunderstorm-watch': { ...dark('#db7093', 8), edgePx: 2, fillAlpha: 0.12 },
    // Storm reports (NWS local storm reports), in SPC's report colours: tornado red, hail
    // green, wind blue.
    'weather-alert.report-tornado': dark('#ff2d2d', 9),
    'weather-alert.report-hail': dark('#2ee65b', 7),
    'weather-alert.report-wind': dark('#3b82f6', 7),
    // SPC convective outlook categories in SPC's own palette, faint fills: they are large and
    // nested, and the map and the warnings must read through them.
    'weather-alert.spc-tstm': { ...dark('#c1e9c1', 6), fillAlpha: 0.08 },
    'weather-alert.spc-mrgl': { ...dark('#66a366', 6), fillAlpha: 0.12 },
    'weather-alert.spc-slgt': { ...dark('#ffe066', 6), fillAlpha: 0.14, edgePx: 2 },
    'weather-alert.spc-enh': { ...dark('#ffa366', 7), fillAlpha: 0.16, edgePx: 2 },
    'weather-alert.spc-mdt': { ...dark('#e06666', 7), fillAlpha: 0.18, edgePx: 2.5 },
    'weather-alert.spc-high': { ...dark('#ee99ee', 8), fillAlpha: 0.2, edgePx: 3 },
    // Tropical cyclones by Saffir–Simpson category (storm-style.ts), in the scale's customary
    // colours — cool for a depression and a tropical storm, pale yellow to red for Categories
    // 1–5 — which read on a dark map and on imagery. Their glyphs, forecast positions and past
    // track share them; post-tropical and the pieces of track before a storm formed are grey.
    storm: dark('#5ebaff', 16),
    'storm.td': dark('#5ebaff', 16),
    'storm.ts': dark('#00faf4', 18),
    'storm.cat1': dark('#ffffcc', 20),
    'storm.cat2': dark('#ffe775', 22),
    'storm.cat3': dark('#ffc140', 24),
    'storm.cat4': dark('#ff8f20', 26),
    'storm.cat5': dark('#ff6060', 28),
    'storm.post': dark('#b8c0cc', 14),
    'storm.weak': dark('#8b949e', 4),
    // The current wind field (NHC advisory wind radii): tropical-storm force (34 kt), 50 kt and
    // hurricane force (64 kt), nested, faint enough that the storm and the map read through.
    'storm.wind-34': { ...dark('#ffe066', 3), fillAlpha: 0.1, edgePx: 1.5 },
    'storm.wind-50': { ...dark('#ff9f40', 3), fillAlpha: 0.14, edgePx: 1.5 },
    'storm.wind-64': { ...dark('#ff4040', 3), fillAlpha: 0.2, edgePx: 2 },
    'weather-station': dark('#93c5fd', 5),
    camera: dark('#a3e635', 5),
    transit: dark('#f9a8d4', 5),
    infrastructure: dark('#94a3b8', 5),
    launch: dark('#fdba74', 8),
    sensor: dark('#86efac', 5),
    'imagery-scene': { ...dark('#c084fc', 5), fillAlpha: 0.03 },
    place: dark('#cbd5e1', 5),
    trail: dark('#e2e8f0', 2),
    // A predicted path (a satellite's next orbit): dashed (presentation.ts), and dimmer than
    // the trail of where the object has been.
    'trail.predicted': dark('#94a3b8', 2),
    // A selected flight's planned route (flight-route.ts): dashed, in the aircraft's hue but
    // paler — a schedule, not where the aircraft has been — and its airports as white points.
    'trail.route': dark('#7dd3fc', 2),
    // The latitude and longitude grid (desktop renderer graticule.ts): faint, beneath everything.
    graticule: dark('#cbd5e1', 1),
    'graticule.label': dark('#cbd5e1', 2),
    // Range rings round the selection (desktop renderer range-rings.ts): outlines only.
    'range-ring': { ...dark('#c4b5fd', 2), fillAlpha: 0, edgePx: 1.5 },
    'range-ring.label': dark('#ddd6fe', 2),
    // The selected satellite's footprint (desktop renderer footprint.ts): 10° up, and the horizon.
    footprint: dark('#fcd34d', 2),
    'footprint.horizon': dark('#fde68a', 1),
    'footprint.label': dark('#fde68a', 2),
    // The selected ship's or aircraft's course vector (desktop renderer course-vector.ts): dashed
    // like the predicted orbit, a tick each few minutes; the boat's own in its pink, paler; the
    // closest point of approach joined in amber, red when it is close.
    'course-vector': dark('#cbd5e1', 2),
    'course-vector.tick': dark('#e2e8f0', 3),
    'course-vector.own': dark('#f9a8d4', 2),
    'course-vector.own.tick': dark('#fbcfe8', 3),
    'course-vector.cpa': dark('#fde68a', 2),
    'course-vector.cpa-close': dark('#f87171', 2),
    // Where the Sun and the Moon stand overhead, with day and night on (desktop sky-points.ts).
    'sky.sun': dark('#fbbf24', 9),
    'sky.moon': dark('#e2e8f0', 8),
    // The measure tool (desktop renderer measure.ts): its line and its points.
    measure: dark('#fbbf24', 3),
    'measure.point': dark('#fde68a', 7),
    'route.airport': dark('#f1f5f9', 6),
    'route.airport.destination': dark('#f8fafc', 8),
    watchzone: dark('#22d3ee', 2),
    'watchzone.paused': dark('#94a3b8', 2),
    event: dark('#f472b6', 8),
    'event.earthquake': dark('#fb923c', 8),
    'event.wildfire-cluster': dark('#f87171', 8),
    'event.weather-alert': dark('#fde047', 8),
    'event.storm': dark('#ffc140', 8),
    'event.launch': dark('#fdba74', 8),
    'event.air-quality': dark('#c084fc', 8),
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
  /** Width in px of an area's edge when its class asks for a bold one (`ThemeEntry.edgePx`), with emphasis. */
  edgeWidthPx?: number;
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
    // A resting outline is translucent. Opaque, it gave a crowd of small dots — 2,500 road
    // stations in Finland — more outline than fill, and they read as one black blot.
    outlineColor: hexToRgba(
      outlineHex,
      style.selected || style.hovered ? Math.min(1, opacity + 0.2) : Math.min(1, opacity * 0.5),
    ),
    outlineWidthPx,
    sizePx,
    opacity,
    labelColor: hexToRgba(entry.label, Math.min(1, opacity + 0.1)),
    labelOutlineColor: hexToRgba(theme.labelOutline, 0.9),
    labelFontPx: theme.labelFontPx,
    fillAlpha: isDensity ? 0.15 + 0.55 * opacity : (entry.fillAlpha ?? 0.25) * opacity,
    rotationDegrees: style.rotationDegrees ?? 0,
    emphasis,
  };
  if (entry.edgePx !== undefined) resolved.edgeWidthPx = entry.edgePx * emphasis;
  if (isCluster) resolved.icon = 'cluster';
  else if (style.icon) resolved.icon = style.icon;
  return resolved;
}

/** Colour for a density cell at a given normalised intensity (0..1): alpha ramps, hue stays. */
export function densityColor(resolved: ResolvedStyle, intensity: number): RgbaColor {
  const t = Math.max(0, Math.min(1, intensity));
  return { ...resolved.color, a: 0.12 + 0.6 * t * resolved.opacity };
}
