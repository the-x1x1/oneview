#!/usr/bin/env node
/**
 * Isolates the Windows Parquet failure seen in the DuckDB conformance suite:
 *
 *   Invalid Input Error: No magic bytes found at end of file '…/opensky-0800.parquet'
 *
 * The backend rolls a partition by reading the existing .parquet, unioning it with the
 * staged NDJSON, writing a .tmp, and renaming that over the original. The suspicion is
 * that replacing a Parquet file *in place* and then reading the same path again is what
 * breaks — DuckDB caches file contents, and on Windows the replaced file is a different
 * file behind the same name.
 *
 * This writes to a temp directory, runs both strategies, prints file sizes at every
 * step, and deletes nothing that would hide the answer.
 *
 *   node tools/dev/duckdb-probe.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveDuckDb() {
  const dirs = [root];
  for (const group of ['packages', 'apps', 'tools']) {
    const g = path.join(root, group);
    if (existsSync(g)) for (const e of readdirSync(g, { withFileTypes: true })) if (e.isDirectory()) dirs.push(path.join(g, e.name));
  }
  for (const d of dirs) {
    const p = path.join(d, 'node_modules', '@duckdb', 'node-api');
    if (existsSync(path.join(p, 'package.json'))) return p;
  }
  return undefined;
}

const duckDir = resolveDuckDb();
if (!duckDir) { console.error('@duckdb/node-api is not installed anywhere in this workspace'); process.exit(2); }
const pkg = JSON.parse(readFileSync(path.join(duckDir, 'package.json'), 'utf8'));
const entry = pathToFileURL(path.join(duckDir, pkg.main ?? 'index.js')).href;
const { DuckDBInstance } = await import(entry);
console.log(`@duckdb/node-api ${pkg.version} from ${path.relative(root, duckDir)}`);

const dir = path.join(os.tmpdir(), `wv-duckdb-probe-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const instance = await DuckDBInstance.create(':memory:');
const conn = await instance.connect();
const run = async (sql) => { const r = await conn.run(sql); return r; };
const rows = async (sql) => { const r = await conn.runAndReadAll(sql); return r.getRowObjects(); };
const duck = (p) => p.split(path.sep).join('/');
const size = (p) => (existsSync(p) ? statSync(p).size : -1);

function stage(file, n, from) {
  writeFileSync(file, Array.from({ length: n }, (_, i) => JSON.stringify({ id: `obj-${from + i}`, t: new Date(1790000000000 + (from + i) * 1000).toISOString() })).join('\n') + '\n');
}

async function roll(parquet, staging, { inPlace }) {
  const exists = existsSync(parquet);
  const sources = [
    ...(exists ? [`SELECT "id", "t" FROM read_parquet('${duck(parquet)}')`] : []),
    `SELECT "id", "t" FROM read_ndjson('${duck(staging)}', columns = {"id": 'VARCHAR', "t": 'VARCHAR'})`,
  ].join(' UNION ALL ');
  const target = inPlace ? `${parquet}.${Date.now()}.tmp` : parquet.replace(/\.parquet$/, `-${Date.now()}.parquet`);
  await run(`COPY (SELECT * FROM (${sources}) ORDER BY "id") TO '${duck(target)}' (FORMAT PARQUET)`);
  console.log(`    wrote ${path.basename(target)}: ${size(target)} bytes`);
  if (inPlace) { await rename(target, parquet); console.log(`    renamed over ${path.basename(parquet)}: ${size(parquet)} bytes`); return parquet; }
  return target;
}

async function attempt(label, inPlace) {
  console.log(`\n== ${label}`);
  const sub = path.join(dir, inPlace ? 'in-place' : 'new-file');
  mkdirSync(sub, { recursive: true });
  const parquet = path.join(sub, 'opensky-0800.parquet');
  const staging = path.join(sub, 'opensky-0800.staging.ndjson');
  const written = [];
  try {
    for (let pass = 1; pass <= 3; pass++) {
      console.log(`  pass ${pass}`);
      stage(staging, 5, pass * 100);
      const file = await roll(parquet, staging, { inPlace });
      if (!written.includes(file)) written.push(file);
      rmSync(staging, { force: true });
      const list = written.map((f) => `'${duck(f)}'`).join(', ');
      const n = await rows(`SELECT count(*) AS n FROM read_parquet([${list}], union_by_name = true)`);
      console.log(`    read back: ${n[0].n} rows`);
    }
    console.log(`  RESULT: ${label} — OK`);
  } catch (err) {
    console.log(`  RESULT: ${label} — FAILED`);
    console.log(`    ${String(err).split('\n')[0]}`);
    console.log(`    parquet on disk: ${size(parquet)} bytes`);
  }
}

await attempt('replace the parquet in place (what the backend does today)', true);
await attempt('write a new parquet file per roll (never replace)', false);

console.log(`\nprobe directory left in place for inspection: ${dir}`);
