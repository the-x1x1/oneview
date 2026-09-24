#!/usr/bin/env node
/**
 * pnpm basemap:build --region <preset|west,south,east,north> --out <dir> --osm <file.osm.pbf> [options]
 *
 * Builds an offline basemap for a region: Planetiler with the Protomaps basemap profile,
 * run on an OSM extract you already have, into `<out>/<id>.pmtiles`, then a world pack
 * `<out>/<id>.worldpack` holding it with the attribution and licence from the legal
 * registry. Nothing is downloaded. docs/OFFLINE-BASEMAPS.md has the whole workflow.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGION_PRESETS } from '@worldview/offline';
import {
  BASEMAP_PROVIDER_ID,
  DEFAULT_MAX_ZOOM,
  buildBasemap,
  profileSourceLines,
  type BasemapBuildOptions,
} from './build.js';
import { JAR_ENV, MIN_JAVA_MAJOR } from './planetiler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const VALUE_FLAGS = new Set([
  'region',
  'out',
  'osm',
  'osm-url',
  'work',
  'java',
  'jar',
  'maxzoom',
  'memory',
  'threads',
  'id',
  'name',
  'map-provider',
]);
const BOOLEAN_FLAGS = new Set(['pmtiles-only', 'dry-run', 'quiet', 'help']);

function usage(): string {
  return [
    'usage: pnpm basemap:build --region <preset|west,south,east,north> --out <dir> --osm <file.osm.pbf> [options]',
    '',
    '  --osm-url <https url>   where the extract came from (recorded in the report, never fetched)',
    '  --work <dir>            holds data/sources/ (below) and temp files; default <out>/work',
    `  --java <path>           default: JAVA_HOME, then PATH (Java ${MIN_JAVA_MAJOR}+)`,
    `  --jar <path>            the Protomaps basemap jar; default: ${JAR_ENV}, then protomaps-basemap-*-with-deps.jar on PATH`,
    `  --maxzoom <0-15>        default ${DEFAULT_MAX_ZOOM}`,
    '  --memory <4g>           Java heap',
    '  --threads <n>',
    '  --id <kebab-id>         default basemap-<preset>',
    '  --name <text>',
    `  --map-provider <id>     registry record for the pack (default ${BASEMAP_PROVIDER_ID})`,
    '  --pmtiles-only          build the PMTiles file only, no pack',
    '  --dry-run               check everything and print the Java command; run nothing',
    '  --quiet                 do not echo Planetiler output (it is still written to <out>/<id>.planetiler.log)',
    '',
    `presets: ${REGION_PRESETS.map((p) => p.id).join(', ')}`,
    '',
    'Files the profile reads from <work>/data/sources/ (get them yourself; nothing is downloaded):',
    ...profileSourceLines(),
  ].join('\n');
}

function parse(argv: string[]): { flags: Map<string, string | true> } | { error: string } {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') {
      flags.set('help', true);
      continue;
    }
    if (!a.startsWith('--')) return { error: `unexpected argument "${a}"` };
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq > 0) return { error: `--${key} takes no value` };
      flags.set(key, true);
    } else if (VALUE_FLAGS.has(key)) {
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') return { error: `--${key} needs a value` };
      flags.set(key, value);
    } else return { error: `unknown option --${key}` };
  }
  return { flags };
}

function intFlag(v: string | true | undefined): number | undefined {
  if (typeof v !== 'string') return undefined;
  return /^-?\d+$/.test(v) ? Number(v) : Number.NaN;
}

async function main(): Promise<number> {
  const parsed = parse(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`${parsed.error}\n\n${usage()}`);
    return 2;
  }
  const f = parsed.flags;
  const str = (k: string): string | undefined => {
    const v = f.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  if (f.has('help')) {
    console.log(usage());
    return 0;
  }
  const region = str('region');
  const out = str('out');
  if (!region || !out) {
    console.error(`--region and --out are required\n\n${usage()}`);
    return 2;
  }
  const quiet = f.has('quiet');
  const abort = new AbortController();
  const onSigint = (): void => {
    console.error('\ninterrupted: stopping Planetiler');
    abort.abort();
  };
  process.once('SIGINT', onSigint);

  const maxZoom = intFlag(f.get('maxzoom'));
  const threads = intFlag(f.get('threads'));
  const opts: BasemapBuildOptions = {
    region,
    outDir: out,
    registryPath: path.join(root, 'config', 'licenses', 'providers.json'),
    env: process.env,
    platform: process.platform,
    log: (line) => console.log(line),
    ...(quiet ? {} : { onOutput: (chunk: string) => process.stdout.write(chunk) }),
    signal: abort.signal,
    ...(str('osm') ? { osmPath: str('osm')! } : {}),
    ...(str('osm-url') ? { osmSourceUrl: str('osm-url')! } : {}),
    ...(str('work') ? { workDir: str('work')! } : {}),
    ...(str('java') ? { java: str('java')! } : {}),
    ...(str('jar') ? { jar: str('jar')! } : {}),
    ...(maxZoom !== undefined ? { maxZoom } : {}),
    ...(str('memory') ? { memory: str('memory')! } : {}),
    ...(threads !== undefined ? { threads } : {}),
    ...(str('id') ? { id: str('id')! } : {}),
    ...(str('name') ? { name: str('name')! } : {}),
    ...(str('map-provider') ? { providerId: str('map-provider')! } : {}),
    ...(f.has('pmtiles-only') ? { pmtilesOnly: true } : {}),
    ...(f.has('dry-run') ? { dryRun: true } : {}),
  };
  const result = await buildBasemap(opts);
  process.removeListener('SIGINT', onSigint);
  if (!result.ok) {
    console.error(`basemap:build stopped at ${result.stage}:`);
    for (const p of result.problems) console.error(`  - ${p}`);
    return result.stage === 'arguments' || result.stage === 'prerequisites' ? 2 : 1;
  }
  if (result.dryRun) {
    console.log('dry run: every prerequisite is in place. Planetiler would run as:');
    console.log(`  cd ${result.command.cwd}`);
    console.log(`  ${[result.command.java, ...result.command.args].join(' ')}`);
    return 0;
  }
  const r = result.report;
  console.log(
    r.pack
      ? `done: ${r.pack.path} (${r.pack.sizeBytes} bytes) — install it in the app (Settings → Offline packs → Install offline pack)`
      : `done: ${r.pmtiles.path} (${r.pmtiles.sizeBytes} bytes), no pack (--pmtiles-only)`,
  );
  for (const w of r.warnings) console.log(`warning: ${w}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`basemap:build failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  },
);
