#!/usr/bin/env node
/**
 * pnpm connector:test <definition.json>… | --all [--json] [--live] [--dir <dir>]
 *
 * Validates connector definitions (schema, connector-specific rules, endpoint policy,
 * credential references, mapping compilation, attribution, data policy, rate policy) and
 * runs the shared connector suite against the fixtures named in each definition's
 * `<name>.test.json` sidecar. `--live` also fetches one sample from the real source (on a
 * machine with network access; secrets from `ONEVIEW_SECRET_<REF>` only). Writes
 * artifacts/verification/connectors/<id>.json as evidence. Exit 1 on any failure.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultConnectorRegistry,
  formatSuite,
  runConnectorSuite,
  type SuiteResult,
} from '@worldview/connector-runtime';
import { loadSidecar, sidecarPathFor } from './fixtures.js';
import { runLive, type LiveResult } from './live.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const all = args.includes('--all');
const json = args.includes('--json');
const live = args.includes('--live');
const dirIndex = args.indexOf('--dir');
const dir = dirIndex >= 0 ? path.resolve(root, args[dirIndex + 1] ?? '') : path.join(root, 'connectors', 'examples');
/** Health states a live sample may end in: anything else means the source did not answer usably. */
const LIVE_OK = new Set(['LIVE', 'DEGRADED', 'STALE', 'STARTING']);
const names = args.filter((a, i) => !a.startsWith('--') && (dirIndex < 0 || i !== dirIndex + 1));

interface Report {
  file: string;
  definitionId: string;
  connector: string;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  suite?: SuiteResult;
  live?: LiveResult;
  passed: boolean;
}

const targets = all
  ? readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.test.json') && !f.startsWith('.'))
      .sort()
      .map((f) => path.join(dir, f))
  : names.map((n) => path.resolve(process.cwd(), n));
if (targets.length === 0) {
  console.error('usage: pnpm connector:test <definition.json>… | --all [--dir <dir>] [--live] [--json]');
  process.exit(2);
}

let failed = false;
for (const file of targets) {
  const report = await runOne(file);
  const outDir = path.join(root, 'artifacts', 'verification', 'connectors');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${safeName(report.definitionId)}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(json ? JSON.stringify(report, null, 2) : format(report));
  console.log('');
  if (!report.passed) failed = true;
}
process.exit(failed ? 1 : 0);

async function runOne(file: string): Promise<Report> {
  const rel = path.relative(root, file);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return {
      file: rel,
      definitionId: path.basename(file, '.json'),
      connector: '?',
      validation: {
        ok: false,
        errors: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
        warnings: [],
      },
      passed: false,
    };
  }
  const v = defaultConnectorRegistry.validate(doc);
  const report: Report = {
    file: rel,
    definitionId: v.definition?.id ?? String((doc as { id?: unknown })?.id ?? path.basename(file, '.json')),
    connector: v.definition?.connector ?? String((doc as { connector?: unknown })?.connector ?? '?'),
    validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
    passed: v.ok,
  };
  if (!v.ok || !v.definition) return report;
  const sidecar = sidecarPathFor(file);
  if (existsSync(sidecar)) {
    try {
      const fixtures = loadSidecar(sidecar, root);
      report.suite = await runConnectorSuite(doc, fixtures, defaultConnectorRegistry);
      if (!report.suite.passed) report.passed = false;
    } catch (err) {
      report.validation.errors.push(`sidecar: ${err instanceof Error ? err.message : String(err)}`);
      report.passed = false;
    }
  } else
    report.validation.warnings.push(`no ${path.basename(sidecar)} beside the definition: the shared suite did not run`);
  if (live) {
    report.live = await runLive(v.definition);
    if (report.live.errors.length || !LIVE_OK.has(report.live.status)) report.passed = false;
  }
  return report;
}

function format(r: Report): string {
  const lines: string[] = [];
  lines.push(`${r.passed ? 'PASS' : 'FAIL'} ${r.file} — ${r.definitionId} (${r.connector})`);
  for (const e of r.validation.errors) lines.push(`  ✗ ${e}`);
  for (const w of r.validation.warnings) lines.push(`  ! ${w}`);
  if (r.suite)
    lines.push(
      ...formatSuite(r.suite)
        .split('\n')
        .map((l) => `  ${l}`),
    );
  if (r.live) {
    const l = r.live;
    lines.push(
      `  live: ${l.status}${l.message ? ` — ${l.message}` : ''}; ${l.observations} observation(s), ${l.rejected} rejected`,
    );
    if (l.sample)
      lines.push(
        `  sample: ${l.sample.externalId ?? l.sample.id} at ${l.sample.observedAt}${l.sample.latitude !== undefined ? ` (${l.sample.latitude}, ${l.sample.longitude})` : ''}`,
      );
    for (const w of l.warnings) lines.push(`  ! ${w}`);
    for (const e of l.errors) lines.push(`  ✗ ${e}`);
  }
  return lines.join('\n');
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}
