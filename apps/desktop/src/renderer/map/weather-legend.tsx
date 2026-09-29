import { useMemo, useState, type CSSProperties } from 'react';
import type { RasterOverlay, WorldObject } from '@worldview/world-model';
import {
  CYCLONE_CATEGORIES,
  CYCLONE_CATEGORY_SHORT,
  WEATHER_ALERT_SUFFIXES,
  cycloneOf,
  hazardStyle,
  themeEntry,
} from '@worldview/render-core';
import { useAppState } from '../store/store.js';

/**
 * A small key to the weather on the map, bottom left above the credits, shown only for what
 * is on it: the radar's reflectivity scale when the nowCOAST radar overlay is drawn, the
 * IMERG precipitation-rate scale when that overlay is, the lightning density scale when the
 * nowCOAST lightning overlay is, the SPC outlook categories, the warning kinds, the
 * storm-report types and the tropical cyclone categories and wind rings when objects of
 * theirs are in the view's data.
 * Nothing is shown when none of these is on. Read-only and out of the pointer's way.
 *
 * Colours: the SPC, warning and report keys are the theme's own classes (render-core
 * theme.ts), so they match the map exactly. The IMERG ramp is GIBS's colour map for the layer
 * (`colormaps/v1.3/GPM_Precipitation_Rate.xml`, rain entries at its labelled values, read
 * 2026-09-28). The radar ramp is the standard NWS reflectivity palette, which nowCOAST's
 * base-reflectivity style follows; it was not compared with live nowCOAST tiles from the
 * build machine (docs/releases/KNOWN-LIMITATIONS.md). The lightning ramp is the one God's Eye
 * View keys nowCOAST's `lightning_density` style with (src/layers/weather/index.js, MIT), in
 * strikes/km²/min ×10³; not compared with live tiles from here either. The cyclone chips are
 * the theme's `storm.*` classes (storm-style.ts), the Saffir–Simpson colours the glyphs use.
 */

export interface LegendStop {
  color: string;
  label?: string;
}

export interface LegendSection {
  id: 'radar' | 'precipitation' | 'lightning' | 'spc' | 'warnings' | 'reports' | 'cyclones';
  title: string;
  note?: string;
  ramp?: LegendStop[];
  chips?: Array<{ color: string; label: string }>;
}

/** NWS standard reflectivity colours, 5 to 75 dBZ in 5 dBZ steps. */
const RADAR_RAMP: LegendStop[] = [
  { color: '#04e9e7', label: '5' },
  { color: '#019ff4' },
  { color: '#0300f4' },
  { color: '#02fd02', label: '20' },
  { color: '#01c501' },
  { color: '#008e00' },
  { color: '#fdf802', label: '35' },
  { color: '#e5bc00' },
  { color: '#fd9500' },
  { color: '#fd0000', label: '50' },
  { color: '#d40000' },
  { color: '#bc0000' },
  { color: '#f800fd', label: '65' },
  { color: '#9854c6' },
  { color: '#fdfdfd', label: '75' },
];

/** GIBS GPM_Precipitation_Rate, rain, at the colour map's labelled values (mm/h). */
const RAIN_RAMP: LegendStop[] = [
  { color: 'rgb(0,148,36)', label: '0.2' },
  { color: 'rgb(69,192,0)', label: '0.5' },
  { color: 'rgb(195,228,0)', label: '1' },
  { color: 'rgb(255,176,6)', label: '2' },
  { color: 'rgb(255,71,48)', label: '5' },
  { color: 'rgb(231,0,0)', label: '10' },
  { color: 'rgb(156,0,0)', label: '20' },
  { color: 'rgb(51,0,0)', label: '50+' },
];

/** nowCOAST lightning strike density, strikes/km²/min ×10³ (GEV's key for the style). */
const LIGHTNING_RAMP: LegendStop[] = [
  { color: '#ffffcc', label: '0.1' },
  { color: '#ffa400', label: '1' },
  { color: '#ff4500', label: '5' },
  { color: '#ff0000', label: '10' },
  { color: '#ff00ff', label: '50' },
  { color: '#4000c0', label: '100' },
  { color: '#00c7ff', label: '200' },
  { color: '#00ff00', label: '300+' },
];

const WIND_RINGS: Array<[string, string]> = [
  ['wind-34', '34 kt'],
  ['wind-50', '50 kt'],
  ['wind-64', '64 kt'],
];

const SPC: Array<[string, string]> = [
  ['TSTM', 'T-storm'],
  ['MRGL', 'Marginal'],
  ['SLGT', 'Slight'],
  ['ENH', 'Enhanced'],
  ['MDT', 'Moderate'],
  ['HIGH', 'High'],
];

/** Warning kinds in order of urgency, with their legend labels. */
const WARNINGS: Array<[string, string]> = [
  ['tornado-emergency', 'Tornado emergency'],
  ['tornado-pds', 'Tornado (PDS)'],
  ['tornado-warning', 'Tornado warning'],
  ['extreme-wind-warning', 'Extreme wind'],
  ['severe-thunderstorm-destructive', 'Severe t-storm (destructive)'],
  ['severe-thunderstorm-warning', 'Severe t-storm'],
  ['flash-flood-emergency', 'Flash flood emergency'],
  ['flash-flood-warning', 'Flash flood'],
  ['hurricane-warning', 'Hurricane / typhoon'],
  ['storm-surge-warning', 'Storm surge'],
  ['tropical-storm-warning', 'Tropical storm'],
  ['hurricane-watch', 'Hurricane watch'],
  ['tornado-watch', 'Tornado watch'],
  ['severe-thunderstorm-watch', 'Severe t-storm watch'],
];

const REPORTS: Array<[string, string]> = [
  ['report-tornado', 'Tornado'],
  ['report-hail', 'Hail'],
  ['report-wind', 'Wind'],
];

const color = (suffix: string) => themeEntry(`weather-alert.${suffix}`).color;

/** The legend's sections for what is on the map. Pure, for tests. */
export function weatherLegend(overlays: readonly RasterOverlay[], objects: Iterable<WorldObject>): LegendSection[] {
  const providers = new Set(overlays.map((o) => o.providerId));
  const spc = new Set<string>();
  const kinds = new Set<string>();
  const reports = new Set<string>();
  let cyclones = false;
  const rings = new Set<string>();
  for (const o of objects) {
    if (o.type === 'storm' || (o.type === 'weather-alert' && cycloneOf(o))) cyclones = true;
    if (o.type !== 'weather-alert') continue;
    const ring = hazardStyle(o)?.styleClass;
    if (ring?.startsWith('storm.wind-')) rings.add(ring.slice('storm.'.length));
    const p = o.properties;
    if (typeof p['spcCategory'] === 'string') spc.add(p['spcCategory']);
    if (typeof p['alertKind'] === 'string') kinds.add(p['alertKind']);
    const report = typeof p['reportType'] === 'string' ? WEATHER_ALERT_SUFFIXES[p['reportType']] : undefined;
    if (report) reports.add(report);
  }
  const out: LegendSection[] = [];
  if (providers.has('nowcoast-radar')) out.push({ id: 'radar', title: 'Radar, US (dBZ)', ramp: RADAR_RAMP });
  if (providers.has('gibs-imerg-precipitation'))
    out.push({ id: 'precipitation', title: 'Precipitation (mm/h)', note: 'IMERG, about 4 h old', ramp: RAIN_RAMP });
  if (providers.has('nowcoast-strike-density'))
    out.push({ id: 'lightning', title: 'Lightning (strikes/km²/min ×10³)', note: '15 min', ramp: LIGHTNING_RAMP });
  if (spc.size)
    out.push({
      id: 'spc',
      title: 'Severe outlook today (SPC)',
      chips: SPC.map(([category, label]) => ({ color: color(WEATHER_ALERT_SUFFIXES[category]!), label })),
    });
  const warnings = WARNINGS.filter(([kind]) => kinds.has(kind));
  if (warnings.length)
    out.push({
      id: 'warnings',
      title: 'Warnings',
      chips: warnings.map(([kind, label]) => ({ color: color(kind), label })),
    });
  const types = REPORTS.filter(([suffix]) => reports.has(suffix));
  if (types.length)
    out.push({
      id: 'reports',
      title: 'Storm reports, 24 h',
      chips: types.map(([suffix, label]) => ({ color: color(suffix), label })),
    });
  if (cyclones || rings.size)
    out.push({
      id: 'cyclones',
      title: 'Tropical cyclones',
      ...(rings.size ? { note: 'wind field rings' } : {}),
      chips: [
        ...CYCLONE_CATEGORIES.map((c) => ({ color: themeEntry(`storm.${c}`).color, label: CYCLONE_CATEGORY_SHORT[c] })),
        ...WIND_RINGS.filter(([ring]) => rings.has(ring)).map(([ring, label]) => ({
          color: themeEntry(`storm.${ring}`).color,
          label,
        })),
      ],
    });
  return out;
}

// Top left: the bottom of the map belongs to the credit line, which grows to three or four
// lines with the weather sources on, and a legend there covered it.
const box: CSSProperties = {
  position: 'absolute',
  left: 'var(--wv-space-2)',
  top: 'var(--wv-space-2)',
  maxHeight: 'calc(100% - 140px)',
  overflowY: 'auto',
  zIndex: 2,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--wv-space-2)',
  maxWidth: 230,
  padding: 'var(--wv-space-2)',
  borderRadius: 'var(--wv-radius-sm)',
  background: 'color-mix(in srgb, var(--wv-bg) 78%, transparent)',
  color: 'var(--wv-text-secondary)',
  fontSize: 'var(--wv-text-xs)',
  lineHeight: 1.3,
};
const toggle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  color: 'var(--wv-text-primary)',
  fontWeight: 600,
};
const title: CSSProperties = { color: 'var(--wv-text-primary)', fontWeight: 600 };
const bar: CSSProperties = { display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden', marginTop: 3 };
const ticks: CSSProperties = { display: 'flex', marginTop: 1, color: 'var(--wv-text-muted)' };
const chipRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '2px 8px', marginTop: 3 };
const swatch = (c: string): CSSProperties => ({
  display: 'inline-block',
  width: 9,
  height: 9,
  marginRight: 4,
  borderRadius: 2,
  background: c,
  verticalAlign: '-1px',
});

export function WeatherLegend() {
  const { sources, world } = useAppState();
  const sections = useMemo(
    () => weatherLegend(sources.overlays, world.objects.values()),
    [sources.overlays, world.objects],
  );
  // Folded to one line until asked for: the map is what the operator came to see.
  const [open, setOpen] = useState(false);
  if (!sections.length) return null;
  return (
    <div style={box} role="note" aria-label="Weather legend">
      <button type="button" style={toggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Weather legend
      </button>
      {open &&
        sections.map((s) => (
          <div key={s.id}>
            <div>
              <span style={title}>{s.title}</span>
              {s.note ? <span> · {s.note}</span> : null}
            </div>
            {s.ramp ? (
              <>
                <div style={bar}>
                  {s.ramp.map((stop, i) => (
                    <span key={i} style={{ flex: 1, background: stop.color }} />
                  ))}
                </div>
                <div style={ticks}>
                  {s.ramp.map((stop, i) => (
                    <span key={i} style={{ flex: 1, textAlign: 'left' }}>
                      {stop.label ?? ''}
                    </span>
                  ))}
                </div>
              </>
            ) : null}
            {s.chips ? (
              <div style={chipRow}>
                {s.chips.map((c) => (
                  <span key={c.label}>
                    <span style={swatch(c.color)} />
                    {c.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
    </div>
  );
}
