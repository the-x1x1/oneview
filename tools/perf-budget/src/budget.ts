import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPresentationBenchmark, type BenchmarkReport } from '@worldview/render-dense';
import { SqlitePlaceIndex, loadSqlite, type PlaceEntry } from '@worldview/offline';

/**
 * Performance budgets enforced in CI (roadmap 1.0). `config/perf-budgets.json` holds a
 * ceiling for each measured median; `pnpm perf:budget` measures, writes
 * artifacts/verification/perf-budget.json and exits 1 when any median is over its ceiling.
 *
 * What is measured is the CPU side, which a CI runner can measure: the presentation pass and
 * its diff (what the main thread does before a frame can draw, render-dense/benchmark.ts), and
 * the SQLite place index at country scale. GPU frame time needs the operator machine and is
 * read from its `renderer perf` log lines instead (docs/architecture/RENDERING.md).
 */
export type Band = 'global' | 'regional' | 'local';

export interface PresentationBudget {
  objects: number;
  band: Band;
  frameMedianMs: number;
  measured?: number;
}

export interface Budgets {
  presentation: { iterations: number; cases: PresentationBudget[] };
  placeSearch?: { entries: number; buildMs: number; queryMedianMs: number };
}

export interface BudgetResult {
  name: string;
  measuredMs: number;
  budgetMs: number;
  pass: boolean;
}

export interface BudgetReport {
  ranAt: string;
  node: string;
  platform: string;
  cpus: number;
  results: BudgetResult[];
  skipped: string[];
  passed: boolean;
}

const BANDS: ReadonlySet<string> = new Set(['global', 'regional', 'local']);

/** The budgets file, checked: a malformed budget is an error, never a pass. */
export function parseBudgets(raw: unknown): Budgets {
  const fail = (why: string): never => {
    throw new Error(`config/perf-budgets.json: ${why}`);
  };
  if (!raw || typeof raw !== 'object') fail('not an object');
  const r = raw as Record<string, unknown>;
  const p = r['presentation'] as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') fail('presentation missing');
  const iterations = p!['iterations'];
  if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 3 || iterations > 50)
    fail('presentation.iterations must be an integer 3–50');
  const cases = p!['cases'];
  if (!Array.isArray(cases) || cases.length === 0) fail('presentation.cases must be a non-empty list');
  const seen = new Set<string>();
  const parsed: PresentationBudget[] = (cases as unknown[]).map((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const objects = o['objects'];
    const band = o['band'];
    const ceiling = o['frameMedianMs'];
    if (typeof objects !== 'number' || !Number.isInteger(objects) || objects < 1 || objects > 1_000_000)
      fail(`presentation.cases[${i}].objects`);
    if (typeof band !== 'string' || !BANDS.has(band)) fail(`presentation.cases[${i}].band`);
    if (typeof ceiling !== 'number' || !(ceiling > 0)) fail(`presentation.cases[${i}].frameMedianMs`);
    const key = `${objects}/${band}`;
    if (seen.has(key)) fail(`presentation.cases: ${key} twice`);
    seen.add(key);
    const out: PresentationBudget = {
      objects: objects as number,
      band: band as Band,
      frameMedianMs: ceiling as number,
    };
    if (typeof o['measured'] === 'number') out.measured = o['measured'];
    return out;
  });
  const budgets: Budgets = { presentation: { iterations: iterations as number, cases: parsed } };
  const s = r['placeSearch'] as Record<string, unknown> | undefined;
  if (s !== undefined) {
    const entries = s['entries'];
    const buildMs = s['buildMs'];
    const queryMedianMs = s['queryMedianMs'];
    if (typeof entries !== 'number' || !Number.isInteger(entries) || entries < 1000) fail('placeSearch.entries');
    if (typeof buildMs !== 'number' || !(buildMs > 0)) fail('placeSearch.buildMs');
    if (typeof queryMedianMs !== 'number' || !(queryMedianMs > 0)) fail('placeSearch.queryMedianMs');
    budgets.placeSearch = {
      entries: entries as number,
      buildMs: buildMs as number,
      queryMedianMs: queryMedianMs as number,
    };
  }
  return budgets;
}

/** Each presentation budget against the benchmark case it names; a case not measured fails. */
export function evaluatePresentation(report: BenchmarkReport, budgets: readonly PresentationBudget[]): BudgetResult[] {
  return budgets.map((b) => {
    const c = report.cases.find((x) => x.objects === b.objects && x.band === b.band);
    const measured = c ? c.frame.medianMs : Number.POSITIVE_INFINITY;
    return {
      name: `presentation ${b.objects.toLocaleString('en-US')} objects, ${b.band} (present + diff, median)`,
      measuredMs: measured,
      budgetMs: b.frameMedianMs,
      pass: measured <= b.frameMedianMs,
    };
  });
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Synthetic places, deterministic: syllable names, spread over the world, importance varied. */
export function syntheticPlaces(count: number): PlaceEntry[] {
  const syllables = ['ka', 'lo', 'ma', 'ri', 'to', 'na', 'se', 'vi', 'du', 'pe', 'go', 'ha'];
  const out: PlaceEntry[] = [];
  for (let i = 0; i < count; i++) {
    const name = `${syllables[i % 12]}${syllables[Math.floor(i / 12) % 12]}${syllables[Math.floor(i / 144) % 12]} ${i}`;
    out.push({
      id: `place:bench:${i}`,
      name,
      altNames: [],
      kind: 'city',
      position: { latitude: -60 + (i % 1200) / 10, longitude: -180 + (Math.floor(i / 1200) % 1200) * 0.3 },
      importance: (i % 997) / 997,
    });
  }
  return out;
}

/** Queries a user types: prefixes, a full name, two words, a miss. */
export const PLACE_QUERIES: readonly string[] = ['ka', 'kalo', 'kaloka 12', 'ma ri', 'seri', 'hago', 'zzzz'];

export async function measurePlaceSearch(
  budget: NonNullable<Budgets['placeSearch']>,
  dir: string,
  now: () => number = () => performance.now(),
): Promise<BudgetResult[] | string> {
  const sqlite = await loadSqlite();
  if (!sqlite) return `no node:sqlite in ${process.version}: place search not measured`;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `perf-budget-${process.pid}.sqlite`);
  const entries = syntheticPlaces(budget.entries);
  try {
    const t0 = now();
    const { index } = await SqlitePlaceIndex.openOrBuild(sqlite, file, 'f'.repeat(64), async () => entries);
    const buildMs = now() - t0;
    const samples: number[] = [];
    for (let round = 0; round < 3; round++)
      for (const q of PLACE_QUERIES) {
        const t = now();
        index.search(q, { limit: 10 });
        samples.push(now() - t);
      }
    const queryMs = median(samples);
    return [
      {
        name: `place index build, ${budget.entries.toLocaleString('en-US')} places (SQLite FTS5)`,
        measuredMs: buildMs,
        budgetMs: budget.buildMs,
        pass: buildMs <= budget.buildMs,
      },
      {
        name: `place search, ${budget.entries.toLocaleString('en-US')} places (median of ${samples.length})`,
        measuredMs: queryMs,
        budgetMs: budget.queryMedianMs,
        pass: queryMs <= budget.queryMedianMs,
      },
    ];
  } finally {
    await fs.rm(file, { force: true });
  }
}

export async function runBudgets(budgets: Budgets, scratchDir: string): Promise<BudgetReport> {
  const sizes = [...new Set(budgets.presentation.cases.map((c) => c.objects))].sort((a, b) => a - b);
  const bench = runPresentationBenchmark({ sizes, iterations: budgets.presentation.iterations });
  const results = evaluatePresentation(bench, budgets.presentation.cases);
  const skipped: string[] = [];
  if (budgets.placeSearch) {
    const place = await measurePlaceSearch(budgets.placeSearch, scratchDir);
    if (typeof place === 'string') skipped.push(place);
    else results.push(...place);
  }
  return {
    ranAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: os.cpus().length,
    results,
    skipped,
    passed: results.every((r) => r.pass),
  };
}

export function formatReport(report: BudgetReport): string {
  const lines = [`performance budgets (${report.node}, ${report.platform}, ${report.cpus} CPUs)`];
  for (const r of report.results)
    lines.push(
      `  ${r.pass ? 'PASS' : 'FAIL'}  ${r.measuredMs.toFixed(1).padStart(8)} ms  ≤ ${String(r.budgetMs).padStart(6)} ms  ${r.name}`,
    );
  for (const s of report.skipped) lines.push(`  SKIP  ${s}`);
  lines.push(report.passed ? 'all within budget' : 'OVER BUDGET');
  return lines.join('\n');
}
