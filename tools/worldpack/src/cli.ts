#!/usr/bin/env node
/**
 * pnpm worldpack <command>
 *
 *   build   --region <preset> | --bbox w,s,e,n | --center lat,lon --radius-km N
 *           --include map,places,airports,earthquakes
 *           [--pmtiles file] [--map-provider id] [--places file] [--airports file] [--history-dir dir] [--days N]
 *           [--id id] [--name name] [--version x.y.z] [--out file] [--report file] [--min-app x.y.z]
 *   verify  <file.worldpack>
 *   inspect <file.worldpack> [--json]
 *   regions
 *
 * Data policies come from config/licenses/providers.json (the legal registry) plus the
 * bundled seed fixtures (MIT). A source whose policy forbids offline packs or
 * redistribution refuses the whole build.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderDataPolicy } from '@worldview/provider-sdk';
import { dataPolicySchema } from '@worldview/provider-sdk';
import { HistoryStore, createHistoryBackend } from '@worldview/history-store';
import {
  REGION_PRESETS, WORLDPACK_INCLUDES, WorldPackBuildError, WorldPackBuilder, formatVerification, readWorldPackManifest, regionPreset, seedPolicies, verifyWorldPack,
  type WorldPackInclude, type WorldPackRegionInput,
} from '@worldview/offline';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argv = process.argv.slice(2);
const command = argv[0];

interface Args { positional: string[]; flags: Map<string, string | true> }

function parseArgs(list: string[]): Args {
  const out: Args = { positional: [], flags: new Map() };
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { out.flags.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags.set(a.slice(2), next); i++; } else out.flags.set(a.slice(2), true);
    } else out.positional.push(a);
  }
  return out;
}

function flag(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function usage(code: number): never {
  console.error([
    'usage:',
    '  pnpm worldpack build --region hawaii --include map,places,airports,earthquakes [--pmtiles file] [--places file] [--airports file] [--history-dir dir] [--out file]',
    '  pnpm worldpack build --bbox -161,18.5,-154.5,22.5 --include places   |   --center 21.3,-157.9 --radius-km 150',
    '  pnpm worldpack verify <file.worldpack>',
    '  pnpm worldpack inspect <file.worldpack> [--json]',
    '  pnpm worldpack regions',
    '',
    `presets: ${REGION_PRESETS.map((p) => p.id).join(', ')}`,
    `includes: ${WORLDPACK_INCLUDES.join(', ')}`,
  ].join('\n'));
  process.exit(code);
}

interface RegistryRecord { providerId: string; license?: string; dataPolicy?: unknown }

/** config/licenses/providers.json → policy + licence name per provider, merged with the seed fixtures' MIT policy. */
function loadPolicies(): { policies: (id: string) => ProviderDataPolicy | undefined; licenses: (id: string) => string | undefined } {
  const file = path.join(root, 'config', 'licenses', 'providers.json');
  const policies = new Map<string, ProviderDataPolicy>(Object.entries(seedPolicies()));
  const licenses = new Map<string, string>([['worldview-seed-places', 'MIT'], ['worldview-seed-airports', 'MIT']]);
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records?: RegistryRecord[] };
    for (const rec of parsed.records ?? []) {
      const r = dataPolicySchema.parse(rec.dataPolicy);
      if (!r.ok) { console.error(`warning: providers.json record "${rec.providerId}" has an invalid dataPolicy and is ignored`); continue; }
      policies.set(rec.providerId, r.value);
      if (rec.license) licenses.set(rec.providerId, rec.license);
    }
  } else {
    console.error('warning: config/licenses/providers.json not found; only the seed fixtures have a policy');
  }
  return { policies: (id) => policies.get(id), licenses: (id) => licenses.get(id) };
}

function parseRegion(args: Args): { region: WorldPackRegionInput; label: string; name: string } {
  const preset = flag(args, 'region');
  const bbox = flag(args, 'bbox');
  const center = flag(args, 'center');
  if (preset) {
    const p = regionPreset(preset);
    if (!p) { console.error(`unknown region preset "${preset}" (run: pnpm worldpack regions)`); process.exit(2); }
    return { region: { preset }, label: p.id, name: p.name };
  }
  if (bbox) {
    const parts = bbox.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) { console.error('--bbox expects west,south,east,north'); process.exit(2); }
    const [west, south, east, north] = parts as [number, number, number, number];
    return { region: { bounds: { west, south, east, north } }, label: 'bbox', name: `Bounds ${bbox}` };
  }
  if (center) {
    const [lat, lon] = center.split(',').map(Number);
    const km = Number(flag(args, 'radius-km'));
    if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(km) || km <= 0) { console.error('--center expects lat,lon and --radius-km a positive number'); process.exit(2); }
    return { region: { center: { latitude: lat, longitude: lon }, radiusM: km * 1000 }, label: 'circle', name: `${km} km around ${lat},${lon}` };
  }
  console.error('a region is required: --region <preset> | --bbox w,s,e,n | --center lat,lon --radius-km N');
  return process.exit(2);
}

async function build(args: Args): Promise<number> {
  const { region, label, name } = parseRegion(args);
  const includeRaw = flag(args, 'include') ?? 'places,airports';
  const include = includeRaw.split(',').map((s) => s.trim()).filter(Boolean) as WorldPackInclude[];
  for (const inc of include) if (!WORLDPACK_INCLUDES.includes(inc)) { console.error(`unknown include "${inc}" (allowed: ${WORLDPACK_INCLUDES.join(', ')})`); return 2; }
  const id = flag(args, 'id') ?? label;
  const outputPath = path.resolve(flag(args, 'out') ?? `${id}.worldpack`);
  const { policies, licenses } = loadPolicies();
  const placesGeoJsonPath = path.resolve(flag(args, 'places') ?? path.join(root, 'fixtures', 'places', 'seed-places.geojson'));
  const airportsGeoJsonPath = path.resolve(flag(args, 'airports') ?? path.join(root, 'fixtures', 'airports', 'seed-airports.geojson'));
  const pmtiles = flag(args, 'pmtiles');
  const mapProvider = flag(args, 'map-provider');
  const historyDir = flag(args, 'history-dir');
  const days = flag(args, 'days');
  const version = flag(args, 'version');
  const minApp = flag(args, 'min-app');
  const report = flag(args, 'report');

  let history: HistoryStore | undefined;
  if (include.includes('earthquakes')) {
    if (!historyDir) { console.error('--history-dir <app data dir> is required for --include earthquakes'); return 2; }
    const created = await createHistoryBackend({ dataDir: path.resolve(historyDir), preferred: 'duckdb-parquet' });
    if (created.fallbackReason) console.error(`history: ${created.requestedBackend} unavailable (${created.fallbackReason}); reading NDJSON partitions`);
    history = new HistoryStore({ dataDir: path.resolve(historyDir), backend: created.backend, policies });
    await history.open();
  }
  try {
    const result = await new WorldPackBuilder().build({
      id, name: flag(args, 'name') ?? name, region, include,
      sources: {
        placesGeoJsonPath, airportsGeoJsonPath,
        ...(pmtiles ? { pmtilesPath: path.resolve(pmtiles) } : {}),
        ...(mapProvider ? { pmtilesProviderId: mapProvider } : {}),
        ...(history ? { history } : {}),
        ...(days ? { earthquakeWindowDays: Number(days) } : {}),
      },
      policies, licenses, outputPath,
      ...(version ? { version } : {}),
      ...(minApp ? { minimumAppVersion: minApp } : {}),
      ...(report ? { reportPath: path.resolve(report) } : {}),
    });
    console.log(`built ${result.outputPath} (${result.sizeBytes} bytes, ${result.entries.length} entries, ${result.searchIndexEntries} places indexed) in ${result.durationMs} ms`);
    for (const e of result.entries) console.log(`  ${e.path.padEnd(36)} ${e.kind.padEnd(12)} ${String(e.sizeBytes).padStart(12)} B${e.rowCount !== undefined ? `  ${e.rowCount} rows` : ''}${e.providerId ? `  ${e.providerId}` : ''}`);
    for (const s of result.sources) console.log(`  source ${s.providerId}: ${s.license} — ${s.attribution}`);
    for (const w of result.warnings) console.log(`  warning: ${w}`);
    console.log(`report: ${result.reportPath}`);
    return 0;
  } catch (err) {
    if (err instanceof WorldPackBuildError) { console.error(`build refused [${err.code}]: ${err.message}`); return 1; }
    throw err;
  } finally {
    await history?.close();
  }
}

async function verify(args: Args): Promise<number> {
  const file = args.positional[1];
  if (!file) usage(2);
  const v = await verifyWorldPack(path.resolve(file), { now: Date.now() });
  console.log(formatVerification(v));
  return v.ok ? 0 : 1;
}

async function inspect(args: Args): Promise<number> {
  const file = args.positional[1];
  if (!file) usage(2);
  const r = await readWorldPackManifest(path.resolve(file));
  if (!r.ok) { console.error(`cannot inspect: ${r.issues.join('; ')}`); return 1; }
  if (args.flags.has('json')) { console.log(JSON.stringify({ manifest: r.manifest, entries: r.entries.map((e) => ({ name: e.name, method: e.method, compressedSize: e.compressedSize, uncompressedSize: e.uncompressedSize })) }, null, 2)); return 0; }
  const m = r.manifest;
  const b = m.geographicBounds;
  console.log(`${m.id} — ${m.name}${m.version ? ` v${m.version}` : ''}`);
  console.log(`  created ${m.createdAt}${m.expiresAt ? ` · expires ${m.expiresAt}` : ''} · min app ${m.minimumAppVersion} · format ${m.formatVersion}`);
  console.log(`  bounds W ${b.west} S ${b.south} E ${b.east} N ${b.north}`);
  console.log('  contents:');
  for (const c of m.contents) {
    const e = r.entries.find((x) => x.name === c.path);
    console.log(`    ${c.path.padEnd(36)} ${c.kind.padEnd(12)} ${String(c.sizeBytes).padStart(12)} B${e ? ` (${e.compressedSize} in archive)` : ''}${c.rowCount !== undefined ? `  ${c.rowCount} rows` : ''}${c.providerId ? `  ${c.providerId}` : ''}`);
  }
  console.log('  sources:');
  for (const s of m.sourcePolicies) console.log(`    ${s.providerId}: ${s.license} — ${s.attribution}${s.termsUrl ? ` (${s.termsUrl})` : ''}`);
  console.log('  note: inspect reads the manifest only; run `pnpm worldpack verify` to check every checksum.');
  return 0;
}

function regions(): number {
  for (const p of REGION_PRESETS) console.log(`${p.id.padEnd(16)} ${p.name.padEnd(28)} W ${p.bounds.west} S ${p.bounds.south} E ${p.bounds.east} N ${p.bounds.north}`);
  return 0;
}

const args = parseArgs(argv);
let code: number;
switch (command) {
  case 'build': code = await build(args); break;
  case 'verify': code = await verify(args); break;
  case 'inspect': code = await inspect(args); break;
  case 'regions': code = regions(); break;
  default: usage(command === undefined || command === '--help' || command === 'help' ? 0 : 2);
}
process.exit(code);
