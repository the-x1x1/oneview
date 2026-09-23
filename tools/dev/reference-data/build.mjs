#!/usr/bin/env node
/**
 * Build the reference layer the app ships — faint country and state borders and their
 * names — from the files download.mjs fetched, plus the 2D label glyphs.
 *
 *   node tools/dev/reference-data/build.mjs <raw-dir> [<out-dir>]
 *
 * <raw-dir> is download.mjs's output (with its manifest.json); <out-dir> defaults to
 * apps/desktop/assets. Every input is checked against the manifest's SHA-256 first, so
 * what is built is what was downloaded. The output is deterministic for a given input.
 *
 * Borders (Natural Earth 10m, public domain):
 *  - countries: ne_10m_admin_0_boundary_lines_land, every class except "Overlay limit" and
 *    "Lease limit" (administrative overlays, not borders); disputed, indefinite, line-of-
 *    control and unrecognised lines are marked so they can be drawn dashed.
 *  - states: ne_10m_admin_1_states_provinces_lines, every class but "Admin-1 boundary
 *    indicator" (unnamed marks at sea) and "Unrecognized Admin-1 boundary". The
 *    "statistical" classes are not optional extras: Natural Earth files real borders under
 *    them — California–Nevada, Arizona–California, Texas–New Mexico among 48 in the US.
 *  Lines are simplified (Douglas-Peucker) and quantised to 1/1000° (~110 m) — inside Natural
 *  Earth 10m's own accuracy — and stored delta-encoded:
 *  `[z, flags, x0, y0, dx1, dy1, …]` in thousandths of a degree, `z` the minimum zoom
 *  (Natural Earth's MIN_ZOOM, 256-px web zoom), flags bit 0 = dashed.
 *
 * Labels (Natural Earth, public domain):
 *  - countries: ne_50m_admin_0_countries LABEL_X/LABEL_Y, NAME_EN (else NAME),
 *    MIN_LABEL/MAX_LABEL, LABELRANK.
 *  - states: ne_10m_admin_1_states_provinces latitude/longitude, name_en (else name),
 *    min_label/max_label, labelrank, the country code; labels Natural Earth never shows
 *    (min_label > 11) are dropped.
 *
 * Glyphs: Noto Sans Regular SDF ranges (SIL OFL 1.1) copied with the licence text.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

export const FORMAT_BORDERS = 'worldview-reference-borders@1';
export const FORMAT_LABELS = 'worldview-reference-labels@1';
const Q = 1000; // quantisation: thousandths of a degree
const TOLERANCE = { country: 0.002, state: 0.004 }; // degrees
const COUNTRY_SKIP = new Set(['Overlay limit', 'Lease limit']);
const COUNTRY_SOLID = new Set(['International boundary (verify)']);
const STATE_KEEP = new Set([
  'Admin-1 boundary',
  'Admin-1 region boundary',
  'Admin-1 statistical boundary',
  'Admin-1 statistical meta bounds',
]);

/** Perpendicular distance from p to segment a–b, in degrees (planar; fine at these scales). */
function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker, iterative. Keeps the endpoints. */
export function simplify(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let max = -1;
    let at = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i], points[s], points[e]);
      if (d > max) {
        max = d;
        at = i;
      }
    }
    if (max > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([s, at], [at, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Quantise, drop repeats, delta-encode: `[x0, y0, dx1, dy1, …]`, or undefined when under two points. */
export function encodeLine(points) {
  const q = [];
  for (const [lon, lat] of points) {
    const x = Math.round(lon * Q);
    const y = Math.round(lat * Q);
    const last = q[q.length - 1];
    if (!last || last[0] !== x || last[1] !== y) q.push([x, y]);
  }
  if (q.length < 2) return undefined;
  const out = [q[0][0], q[0][1]];
  for (let i = 1; i < q.length; i++) out.push(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
  return out;
}

function parts(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function buildBorders(countryLines, stateLines) {
  const lines = [];
  const stats = {
    country: { in: 0, out: 0, vertsIn: 0, vertsOut: 0 },
    state: { in: 0, out: 0, vertsIn: 0, vertsOut: 0 },
  };
  const add = (kind, feature, flags, z) => {
    for (const part of parts(feature.geometry)) {
      stats[kind].in++;
      stats[kind].vertsIn += part.length;
      const simple = simplify(part, TOLERANCE[kind]);
      const enc = encodeLine(simple);
      if (!enc) continue;
      stats[kind].out++;
      stats[kind].vertsOut += enc.length / 2;
      lines.push({ kind, row: [z, flags, ...enc] });
    }
  };
  for (const f of countryLines.features) {
    const cls = f.properties?.FEATURECLA;
    if (COUNTRY_SKIP.has(cls)) continue;
    add('country', f, COUNTRY_SOLID.has(cls) ? 0 : 1, Math.round(num(f.properties?.MIN_ZOOM, 0) * 10) / 10);
  }
  for (const f of stateLines.features) {
    if (!STATE_KEEP.has(f.properties?.FEATURECLA)) continue;
    add('state', f, 0, Math.round(num(f.properties?.MIN_ZOOM, 6) * 10) / 10);
  }
  return {
    doc: {
      format: FORMAT_BORDERS,
      quantisation: 1 / Q,
      countries: lines.filter((l) => l.kind === 'country').map((l) => l.row),
      states: lines.filter((l) => l.kind === 'state').map((l) => l.row),
    },
    stats,
  };
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;

export function buildLabels(countries, states) {
  const c = [];
  for (const f of countries.features) {
    const p = f.properties ?? {};
    const name = String(p.NAME_EN ?? p.NAME ?? '').trim();
    const x = num(p.LABEL_X);
    const y = num(p.LABEL_Y);
    if (!name || x === undefined || y === undefined) continue;
    c.push([name, round4(x), round4(y), num(p.MIN_LABEL, 3), num(p.MAX_LABEL, 10), num(p.LABELRANK, 5)]);
  }
  const s = [];
  for (const f of states.features) {
    const p = f.properties ?? {};
    const name = String(p.name_en ?? p.name ?? '').trim();
    const x = num(p.longitude);
    const y = num(p.latitude);
    const min = num(p.min_label, 99);
    if (!name || x === undefined || y === undefined || min > 11) continue;
    s.push([name, round4(x), round4(y), min, num(p.max_label, 11), num(p.labelrank, 6), String(p.adm0_a3 ?? '')]);
  }
  const byRank = (a, b) => a[5] - b[5] || a[3] - b[3] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  c.sort(byRank);
  s.sort(byRank);
  return {
    format: FORMAT_LABELS,
    fields: {
      countries: ['name', 'lon', 'lat', 'minZoom', 'maxZoom', 'rank'],
      states: ['name', 'lon', 'lat', 'minZoom', 'maxZoom', 'rank', 'country'],
    },
    countries: c,
    states: s,
  };
}

function main() {
  const raw = path.resolve(process.argv[2] ?? 'reference-raw');
  const out = path.resolve(process.argv[3] ?? path.join(repoRoot, 'apps', 'desktop', 'assets'));
  const manifest = JSON.parse(readFileSync(path.join(raw, 'manifest.json'), 'utf8'));
  const byName = new Map(manifest.files.map((f) => [f.name, f]));
  const read = (name) => {
    const entry = byName.get(name);
    if (!entry) throw new Error(`${name} is not in the download manifest`);
    const bytes = readFileSync(path.join(raw, ...name.split('/')));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== entry.sha256) throw new Error(`${name}: sha256 ${sha} does not match the manifest (${entry.sha256})`);
    return bytes;
  };
  const json = (name) => JSON.parse(read(name).toString('utf8'));

  const borders = buildBorders(
    json('natural-earth/ne_10m_admin_0_boundary_lines_land.geojson'),
    json('natural-earth/ne_10m_admin_1_states_provinces_lines.geojson'),
  );
  const labels = buildLabels(
    json('natural-earth/ne_50m_admin_0_countries.geojson'),
    json('natural-earth/ne_10m_admin_1_states_provinces.geojson'),
  );
  const sources = manifest.files
    .filter((f) => f.name.startsWith('natural-earth/'))
    .map((f) => ({ file: f.name.split('/').pop(), url: f.url, sha256: f.sha256 }));
  const provenance = {
    source: 'Natural Earth (public domain) — https://www.naturalearthdata.com/',
    builtBy: 'tools/dev/reference-data/build.mjs',
    downloadedAt: manifest.downloadedAt,
    inputs: sources,
  };

  const refDir = path.join(out, 'reference');
  mkdirSync(refDir, { recursive: true });
  writeFileSync(path.join(refDir, 'borders.json'), JSON.stringify({ ...borders.doc, provenance }));
  writeFileSync(path.join(refDir, 'labels.json'), JSON.stringify({ ...labels, provenance }));

  const fontFiles = manifest.files.filter((f) => f.name.startsWith('fonts/'));
  for (const f of fontFiles) {
    const bytes = read(f.name);
    const dest = path.join(out, ...f.name.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
  writeFileSync(
    path.join(out, 'fonts', 'SOURCES.json'),
    JSON.stringify(
      {
        license: 'SIL Open Font License 1.1 (fonts/OFL.txt)',
        files: fontFiles.map((f) => ({ file: f.name, url: f.url, sha256: f.sha256 })),
      },
      null,
      2,
    ) + '\n',
  );

  const size = (p) => readFileSync(p).length;
  console.log(
    JSON.stringify(
      {
        borders: { bytes: size(path.join(refDir, 'borders.json')), ...borders.stats },
        labels: {
          bytes: size(path.join(refDir, 'labels.json')),
          countries: labels.countries.length,
          states: labels.states.length,
        },
        fonts: fontFiles.length,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
