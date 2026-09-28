#!/usr/bin/env node
/**
 * Build the aviation reference tables the app ships — airline names by ICAO designator and
 * aircraft type names by ICAO type designator — from a checkout of Virtual Radar Server's
 * standing data (https://github.com/vradarserver/standing-data, CC0 1.0).
 *
 *   node tools/dev/aviation-reference/build.mjs <standing-data-dir> [<out-file>]
 *
 * <standing-data-dir> is a clone of the repository (only `airlines/` and `model-type/` are
 * read; a sparse checkout of those two is enough). <out-file> defaults to
 * fixtures/aviation/aviation-reference.json, which tools/dev/stage-resources.mjs copies into
 * the package as resources/data/aviation-reference.json. The runtime reads it to name the
 * airline of a selected flight from its callsign and the aircraft type from its designator
 * (packages/runtime/src/support/flight-info.ts).
 *
 * Why this source: CC0 — no conditions on bundling or redistribution — where OpenFlights'
 * airlines.dat is ODbL (share-alike on a derived database). Why these two tables only: the
 * route lookup (adsb.lol routeset) already answers each airport's name, city and position,
 * and the seed airports cover the rest; an airline or a type needs no network at all.
 *
 * Output (deterministic for a given input; rows sorted by code):
 *   { format, provenance, airlines: [[icao, name, iata?]...], types: [[designator, name]...] }
 *
 * Type names: standing data lists every model a designator covers (C172 has fourteen —
 * Cessna 172, 172 Skyhawk, Reims F172 …), so one is chosen, in this order:
 *   1. the designator's rows still in use (IsActive 1), else all of them;
 *   2. the manufacturer with the most rows (ties: alphabetical);
 *   3. that manufacturer's models' common prefix when it ends at a word boundary and is at
 *      least three characters (787-9 BBJ, 787-9 Dreamliner → 787-9);
 *   4. else the model the others are variants of (`baseModel`).
 * Where a designator covers military and civil variants the name can be a variant's
 * (B06: "Bell OH-58 Kiowa", the military JetRanger); the panel always shows the designator
 * beside it.
 * The result is "<Manufacturer> <Model>", at most 64 characters.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

export const FORMAT = 'worldview-aviation-reference@1';
const MAX_NAME = 64;

/**
 * RFC 4180-ish CSV as standing data writes it: optional double quotes, "" for a quote inside
 * one, commas inside quotes ignored. A UTF-8 BOM on the first line is dropped. Returns rows
 * as objects keyed by the header.
 */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const clip = (s) => (s.length > MAX_NAME ? s.slice(0, MAX_NAME - 1).trimEnd() + '…' : s);

/** `[[icao, name, iata?]]` for every airline with a three-letter ICAO designator, sorted. */
export function buildAirlines(rows) {
  const out = new Map();
  for (const r of rows) {
    const icao = (r.ICAO ?? '').toUpperCase();
    const name = (r.Name ?? '').replace(/\s+/g, ' ').trim();
    if (!/^[A-Z]{3}$/.test(icao) || !name || out.has(icao)) continue;
    const iata = (r.IATA ?? '').toUpperCase();
    out.set(icao, /^[A-Z0-9]{2}$/.test(iata) ? [icao, clip(name), iata] : [icao, clip(name)]);
  }
  return [...out.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The common prefix of `names`, cut back to the last word boundary it reaches. */
export function wordPrefix(names) {
  if (!names.length) return '';
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  // Whole words only: the prefix must end where every name ends or continues with a space.
  if (names.every((n) => n.length === p.length || n[p.length] === ' ')) return p.trim();
  const cut = p.lastIndexOf(' ');
  return cut > 0 ? p.slice(0, cut).trim() : '';
}

/** One name for one designator's rows (see the header for the order of preference). */
export function typeName(rows) {
  const active = rows.filter((r) => r.IsActive === '1');
  const pool = active.length ? active : rows;
  const byMaker = new Map();
  for (const r of pool) {
    if (!r.Model) continue;
    const maker = r.Manufacturer ?? '';
    const list = byMaker.get(maker) ?? [];
    list.push(r.Model);
    byMaker.set(maker, list);
  }
  if (!byMaker.size) return undefined;
  // A named manufacturer before the rows without one (GLID: "Glider", "Sailplane").
  const [maker, models] = [...byMaker.entries()].sort((a, b) =>
    !a[0] !== !b[0] ? (a[0] ? -1 : 1) : b[1].length !== a[1].length ? b[1].length - a[1].length : a[0] < b[0] ? -1 : 1,
  )[0];
  const unique = [...new Set(models)];
  let model;
  if (unique.length === 1) model = unique[0];
  else {
    const prefix = wordPrefix(unique);
    const seen = new Map();
    for (const r of pool) if (r.Model) seen.set(r.Model, (seen.get(r.Model) ?? 0) + 1);
    model = prefix.length >= 3 ? prefix : baseModel(unique, seen);
  }
  if (!maker) return clip(model);
  // "Airbus A-320" rather than "Airbus Airbus A-320" when the model repeats the maker.
  const name = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${maker} ${model}`;
  return clip(name.replace(/\s+/g, ' ').trim());
}

/**
 * The model the others are variants of: the one that begins the most other names as a whole
 * word (PC-12 of PC-12 Eagle and PC-12 Spectre), then the one most manufacturers list
 * (`seen`: F-16 Fighting Falcon, built under licence by six), then the one sharing the
 * longest leading characters with the rest (ATR-72-600 beside ATR-72-212A rather than
 * ATR P-72), then the shortest, then alphabetical.
 */
export function baseModel(models, seen = new Map()) {
  const common = (a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  const scored = models.map((m) => {
    let heads = 0;
    let shared = 0;
    for (const o of models) {
      if (o === m) continue;
      if (o.startsWith(m) && o[m.length] === ' ') heads++;
      shared += common(m, o);
    }
    return { m, heads, shared, times: seen.get(m) ?? 1 };
  });
  scored.sort(
    (a, b) =>
      b.heads - a.heads ||
      b.times - a.times ||
      b.shared - a.shared ||
      a.m.length - b.m.length ||
      (a.m < b.m ? -1 : a.m > b.m ? 1 : 0),
  );
  return scored[0].m;
}

/** `[[designator, name]]` for every real ICAO 8643 designator (fake "-" codes skipped), sorted. */
export function buildTypes(rows) {
  const byCode = new Map();
  for (const r of rows) {
    const code = (r.ICAO ?? '').toUpperCase();
    if (!/^[A-Z0-9]{2,4}$/.test(code)) continue;
    const list = byCode.get(code) ?? [];
    list.push(r);
    byCode.set(code, list);
  }
  const out = [];
  for (const [code, list] of byCode) {
    const name = typeName(list);
    if (name) out.push([code, name]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function main() {
  const [src, outArg] = process.argv.slice(2);
  if (!src) {
    console.error('usage: build.mjs <standing-data-dir> [<out-file>]');
    process.exit(2);
  }
  const out = outArg ?? path.join(repoRoot, 'fixtures', 'aviation', 'aviation-reference.json');
  const airlinesFile = path.join(src, 'airlines', 'schema-01', 'airlines.csv');
  const typesDir = path.join(src, 'model-type', 'schema-01');
  if (!existsSync(airlinesFile) || !existsSync(typesDir)) {
    console.error(`not a standing-data checkout: ${src}`);
    process.exit(2);
  }
  const airlines = buildAirlines(parseCsv(readFileSync(airlinesFile, 'utf8')));
  const typeRows = readdirSync(typesDir)
    .filter((f) => f.endsWith('.csv'))
    .sort()
    .flatMap((f) => parseCsv(readFileSync(path.join(typesDir, f), 'utf8')));
  const types = buildTypes(typeRows);
  let commit;
  try {
    commit = execFileSync('git', ['-C', src, 'log', '-1', '--format=%H %cI'], { encoding: 'utf8' }).trim();
  } catch {
    commit = undefined;
  }
  const doc = {
    format: FORMAT,
    provenance: {
      source: 'Virtual Radar Server standing data — https://github.com/vradarserver/standing-data',
      license: 'CC0 1.0 Universal (public domain dedication)',
      credit: 'Airline and aircraft type names: Virtual Radar Server standing data (CC0 1.0)',
      builtBy: 'tools/dev/aviation-reference/build.mjs',
      ...(commit ? { commit: commit.split(' ')[0], committedAt: commit.split(' ')[1] } : {}),
      inputs: ['airlines/schema-01/airlines.csv', 'model-type/schema-01/*.csv'],
    },
    airlines,
    types,
  };
  mkdirSync(path.dirname(out), { recursive: true });
  // One row per line: the file diffs by airline and type when it is rebuilt.
  const lines = [
    '{',
    `"format":${JSON.stringify(doc.format)},`,
    `"provenance":${JSON.stringify(doc.provenance)},`,
    '"airlines":[',
    airlines.map((r) => JSON.stringify(r)).join(',\n'),
    '],',
    '"types":[',
    types.map((r) => JSON.stringify(r)).join(',\n'),
    ']',
    '}',
  ];
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(
    JSON.stringify({ out: path.relative(repoRoot, out), airlines: airlines.length, types: types.length }, null, 2),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
