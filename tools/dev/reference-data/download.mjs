#!/usr/bin/env node
/**
 * Download the source files behind WORLDVIEW's reference layer (borders and place names)
 * and the 2D label glyphs, and record exactly what was fetched.
 *
 *   node tools/dev/reference-data/download.mjs <out-dir>
 *
 * This only downloads; build.mjs turns the files into the assets the app ships. It is a
 * separate step because the build machine cannot reach these hosts and the operator's can.
 *
 * Sources (licences recorded in config/licenses/providers.json and assets.json):
 *  - Natural Earth vector data at a pinned commit — public domain.
 *  - Noto Sans Regular glyph ranges (MapLibre SDF PBFs) from protomaps/basemaps-assets —
 *    SIL Open Font License 1.1, and the licence text itself.
 *
 * Every file is written with its SHA-256 into manifest.json, so the build can check it is
 * processing what was downloaded and the commit can say which bytes it came from.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const ne = (file) => ({
  name: `natural-earth/${file}`,
  urls: [
    `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_COMMIT}/geojson/${file}`,
    `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${file}`,
  ],
  required: true,
});

const FONT = 'Noto Sans Regular';
/** Latin, Latin-1, Latin Extended A/B, IPA, Greek, Cyrillic, Latin Extended Additional, Greek Extended, punctuation, letterlike symbols. */
const RANGES = [0, 256, 512, 768, 1024, 1280, 7680, 7936, 8192, 8448].map((s) => `${s}-${s + 255}`);
const font = (range) => ({
  name: `fonts/${FONT}/${range}.pbf`,
  urls: [
    `https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts/${encodeURIComponent(FONT)}/${range}.pbf`,
    `https://protomaps.github.io/basemaps-assets/fonts/${encodeURIComponent(FONT)}/${range}.pbf`,
  ],
  required: true,
});

const FILES = [
  ne('ne_10m_admin_0_boundary_lines_land.geojson'),
  ne('ne_10m_admin_1_states_provinces_lines.geojson'),
  ne('ne_50m_admin_0_countries.geojson'),
  ne('ne_10m_admin_1_states_provinces.geojson'),
  ne('ne_10m_populated_places_simple.geojson'),
  ...RANGES.map(font),
  {
    name: 'fonts/OFL.txt',
    urls: [
      'https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/main/OFL.txt',
      'https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts/OFL.txt',
    ],
    required: false,
  },
];

const MAX_BYTES = 200 * 1024 * 1024;

async function fetchOnce(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`${buf.length} bytes is over the ${MAX_BYTES} cap`);
  return buf;
}

async function main() {
  const out = path.resolve(process.argv[2] ?? 'reference-raw');
  mkdirSync(out, { recursive: true });
  const manifest = { downloadedAt: new Date().toISOString(), node: process.version, files: [], failed: [] };
  for (const f of FILES) {
    let done = false;
    const errors = [];
    for (const url of f.urls) {
      for (let attempt = 1; attempt <= 2 && !done; attempt++) {
        try {
          const buf = await fetchOnce(url);
          const file = path.join(out, ...f.name.split('/'));
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, buf);
          const sha256 = createHash('sha256').update(buf).digest('hex');
          manifest.files.push({ name: f.name, url, bytes: buf.length, sha256 });
          console.log(`ok   ${f.name}  ${buf.length} bytes  ${sha256.slice(0, 16)}…  ${url}`);
          done = true;
        } catch (e) {
          errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (done) break;
    }
    if (!done) {
      manifest.failed.push({ name: f.name, required: f.required, errors });
      console.log(`FAIL ${f.name}${f.required ? '' : ' (optional)'}\n     ${errors.join('\n     ')}`);
    }
  }
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const missing = manifest.failed.filter((f) => f.required).length;
  console.log(`\n${manifest.files.length} downloaded, ${manifest.failed.length} failed (${missing} required)`);
  console.log(`DONE ${missing ? 'WITH ERRORS' : 'OK'}`);
  process.exitCode = missing ? 1 : 0;
}

main().catch((e) => {
  console.error(`FATAL ${e instanceof Error ? e.stack : String(e)}`);
  console.log('DONE WITH ERRORS');
  process.exitCode = 1;
});
