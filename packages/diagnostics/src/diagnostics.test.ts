import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiagnosticsSnapshot } from '@worldview/ipc-contract';
import {
  DiagnosticsCollector,
  exportBundle,
  fallbackSnapshot,
  redactPathsInText,
  scanText,
  todoReport,
  type DiagnosticsSources,
} from './index.js';

function sources(overrides: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  const base = fallbackSnapshot(() => Date.parse('2026-09-21T10:00:00Z'));
  return {
    app: () => ({ ...base.app, version: '0.1.0-rc.1', channel: 'prerelease', commit: 'abc1234' }),
    runtime: () => ({ ...base.runtime, electron: '33.0.0', chrome: '130.0.0.0' }),
    providers: () => [],
    database: () => ({ status: 'ok', backend: 'duckdb', sizeBytes: 1024, partitions: 3 }),
    offline: () => base.offline,
    renderer: () => ({ active: '3D', webgl2: true, gpu: 'Test GPU' }),
    sidecars: () => [{ id: 'go2rtc', status: 'not-configured' }],
    updater: () => base.updater,
    disk: () => ({ dataDir: '/home/alice/.config/WorldView', usedBytes: 4096, freeBytes: 1 }),
    logs: () => ({ path: '/home/alice/.config/WorldView/logs/app.log', sizeBytes: 12 }),
    ...overrides,
  };
}

test('collector: assembles a snapshot from injected sources and degrades failing sources', async () => {
  const collector = new DiagnosticsCollector(
    sources({
      database: async () => {
        throw new Error('duckdb not loadable: /home/alice/x');
      },
    }),
  );
  const { snapshot, problems } = await collector.collect();
  assert.equal(snapshot.app.version, '0.1.0-rc.1');
  assert.equal(snapshot.renderer.active, '3D');
  assert.equal(snapshot.database.status, 'error');
  assert.deepEqual(
    problems.map((p) => p.source),
    ['database'],
  );
  const s2 = await collector.snapshot();
  assert.equal(s2.runtime.electron, '33.0.0');
});

test('bundle export: redacts secrets and user paths in snapshot, findings and log tail', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-diag-'));
  const logFile = path.join(dir, 'app.log');
  const lines = [
    JSON.stringify({
      ts: '2026-09-21T09:00:00Z',
      level: 'info',
      category: 'app',
      message: 'started',
      fields: { dataDir: '/home/alice/.config/WorldView' },
    }),
    JSON.stringify({
      ts: '2026-09-21T09:00:01Z',
      level: 'warn',
      category: 'provider',
      message: 'fetch https://api.example/x?api_key=SHOULDNOTLEAK failed',
      fields: { url: 'https://user:pw@cam.local/stream' },
    }),
    'torn line without newline',
  ];
  await fs.writeFile(logFile, lines.join('\n'));
  const snapshot: DiagnosticsSnapshot = await new DiagnosticsCollector(sources()).snapshot();
  const { path: file, bundle } = await exportBundle(dir, {
    snapshot,
    logFile,
    homeDir: '/home/alice',
    now: () => Date.parse('2026-09-21T10:00:00Z'),
    findings: [
      {
        area: 'settings',
        message: 'reset from C:\\Users\\alice\\AppData\\Roaming\\WorldView\\settings.json',
        token: 'abc',
      },
    ],
  });
  assert.equal(path.basename(file), 'worldview-diagnostics-2026-09-21T10-00-00-000Z.json');
  const text = await fs.readFile(file, 'utf8');
  assert.ok(!text.includes('alice'), 'account name never appears in the bundle');
  assert.ok(!text.includes('SHOULDNOTLEAK'));
  assert.ok(!text.includes('user:pw@'));
  assert.equal(bundle.snapshot.disk.dataDir, '~/.config/WorldView');
  assert.equal(bundle.logTail.length, 2, 'torn line skipped');
  assert.equal(bundle.logTailTruncated, false);
  assert.equal((bundle.findings[0] as { token: string }).token, '<redacted>');
  assert.equal(
    (bundle.findings[0] as { message: string }).message,
    'reset from ~\\AppData\\Roaming\\WorldView\\settings.json',
  );
  assert.equal(bundle.redaction.homeDir, '~');
});

test('path redaction handles Windows, macOS and Linux user roots', () => {
  assert.equal(redactPathsInText('C:\\Users\\bob\\AppData', { homeDir: '/nonexistent' }), '~\\AppData');
  assert.equal(redactPathsInText('/Users/bob/Library', { homeDir: '/nonexistent' }), '~/Library');
  assert.equal(redactPathsInText('/home/bob/.config and /home/bob/x', { homeDir: '/home/bob' }), '~/.config and ~/x');
  assert.equal(redactPathsInText('no paths here', { homeDir: '/home/bob' }), 'no paths here');
});

test('todo report: finds markers in comments only, skips tests/fixtures/docs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-todo-'));
  await fs.mkdir(path.join(dir, 'packages', 'x', 'src', 'test'), { recursive: true });
  await fs.mkdir(path.join(dir, 'fixtures'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'packages', 'x', 'src', 'a.ts'),
    [
      'const t = process.env.TEMP; // read the temp dir',
      '// ' + 'TO' + 'DO: finish this',
      'export const TEMP = 1;',
      '/* HA' + 'CK around a bug */',
      'const PLACEHOLDER = "x"; // labelled PLACE' + 'HOLDER on purpose',
    ].join('\n'),
  );
  await fs.writeFile(path.join(dir, 'packages', 'x', 'src', 'a.test.ts'), '// TO' + 'DO in a test is fine');
  await fs.writeFile(path.join(dir, 'packages', 'x', 'src', 'test', 'plan.ts'), '// FIX' + 'ME in test dir is fine');
  await fs.writeFile(path.join(dir, 'fixtures', 'f.ts'), '// FIX' + 'ME in fixtures is fine');
  const report = await todoReport(dir);
  assert.equal(report.filesScanned, 1);
  assert.deepEqual(
    report.entries.map((e) => `${e.line}:${e.tag}`),
    ['2:TODO', '4:HACK', '5:PLACEHOLDER'],
  );
  assert.equal(report.count, 3);
  assert.deepEqual(scanText('const x = a * TEMP_FACTOR;'), []);
});

test('todo report: the real production trees are clean', async () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const report = await todoReport(root);
  assert.ok(report.filesScanned > 20);
  assert.deepEqual(report.entries, [], JSON.stringify(report.entries, null, 2));
});
