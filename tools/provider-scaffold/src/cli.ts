#!/usr/bin/env node
/**
 * pnpm provider:scaffold <id> --name <text> --type <object type> --url <https GeoJSON>
 *                          --licence <as stated> --attribution <text>
 *                          [--id-property <p>] [--time-property <p>] [--interval <seconds>] [--dry-run]
 *
 * Writes providers/<id>/ and fixtures/<id>/ and appends a conservative record to
 * config/licenses/providers.json. Nothing is overwritten: an existing directory or record
 * stops the run before anything is written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCAFFOLD_OBJECT_TYPES, checkOptions, scaffoldProvider, type ScaffoldOptions } from './scaffold.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const USAGE = `usage: pnpm provider:scaffold <id> --name <text> --type <object type> --url <https GeoJSON>
                          --licence <as stated by the source> --attribution <text>
                          [--id-property <p>] [--time-property <p>] [--interval <seconds>] [--dry-run]

object types: ${SCAFFOLD_OBJECT_TYPES.join(', ')}`;

/** Arguments → options, or the reason they are not usable. */
export function parseArgs(argv: readonly string[]): { options: ScaffoldOptions; dryRun: boolean } | string {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) return `--${key} needs a value`;
      flags.set(key === 'license' ? 'licence' : key, value);
    } else positional.push(a);
  }
  const known = new Set(['name', 'type', 'url', 'licence', 'attribution', 'id-property', 'time-property', 'interval']);
  for (const k of flags.keys()) if (!known.has(k)) return `unknown option --${k}`;
  const id = positional[0];
  if (!id || positional.length > 1) return 'one provider id is needed';
  for (const k of ['name', 'type', 'url', 'licence', 'attribution'])
    if (!flags.get(k)?.trim()) return `--${k} is required`;
  const options: ScaffoldOptions = {
    id,
    name: flags.get('name')!,
    objectType: flags.get('type') as ScaffoldOptions['objectType'],
    url: flags.get('url')!,
    licence: flags.get('licence')!,
    attribution: flags.get('attribution')!,
  };
  if (flags.has('id-property')) options.idProperty = flags.get('id-property')!;
  if (flags.has('time-property')) options.timeProperty = flags.get('time-property')!;
  if (flags.has('interval')) options.intervalSeconds = Number(flags.get('interval'));
  const problem = checkOptions(options);
  return problem ?? { options, dryRun };
}

/** Why scaffolding `id` into `repoRoot` would overwrite something, or undefined. */
export function collision(repoRoot: string, id: string): string | undefined {
  if (existsSync(path.join(repoRoot, 'providers', id))) return `providers/${id} already exists`;
  if (existsSync(path.join(repoRoot, 'fixtures', id))) return `fixtures/${id} already exists`;
  const registry = path.join(repoRoot, 'config', 'licenses', 'providers.json');
  if (!existsSync(registry)) return 'config/licenses/providers.json is missing';
  const records = (JSON.parse(readFileSync(registry, 'utf8')) as { records: Array<{ providerId: string }> }).records;
  if (records.some((r) => r.providerId === id)) return `config/licenses/providers.json already has a record for ${id}`;
  return undefined;
}

/** Write the scaffold into `repoRoot`; returns the paths written, relative to it. */
export function writeScaffold(repoRoot: string, options: ScaffoldOptions): string[] {
  const blocked = collision(repoRoot, options.id);
  if (blocked) throw new Error(blocked);
  const result = scaffoldProvider(options);
  const written: string[] = [];
  for (const [rel, content] of Object.entries(result.files)) {
    const abs = path.join(repoRoot, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, { flag: 'wx' });
    written.push(rel);
  }
  const registryFile = path.join(repoRoot, 'config', 'licenses', 'providers.json');
  const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as { records: unknown[] };
  registry.records.push(result.record);
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  written.push('config/licenses/providers.json (record appended)');
  return written;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`${parsed}\n\n${USAGE}`);
    process.exit(2);
  }
  const { options, dryRun } = parsed;
  if (dryRun) {
    const blocked = collision(root, options.id);
    const result = scaffoldProvider(options);
    for (const rel of Object.keys(result.files)) console.log(`would write ${rel}`);
    console.log('would append a record to config/licenses/providers.json');
    if (blocked) console.log(`\nbut: ${blocked} — nothing would be written`);
    process.exit(blocked ? 1 : 0);
  }
  try {
    for (const rel of writeScaffold(root, options)) console.log(`wrote ${rel}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { nextSteps } = scaffoldProvider(options);
  console.log('\nNext:');
  nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}
