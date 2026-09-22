import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUEST_CHANNELS } from '@worldview/ipc-contract';
import { authoritativeRules } from '@worldview/identity';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// `release` is deliberately absent: it is a directory name that means two different
// things. apps/desktop/release is build output; tools/release is source. Skipping it by
// bare name — which is what .gitignore did, and why tools/release was never committed —
// hides real source from this walk. Build output is skipped by path below.
const SKIP = new Set(['node_modules', 'dist', 'out', '.vite', 'build-output', '.git', '.claude', 'artifacts', 'fixtures']);

/**
 * docs/PRODUCT-BOUNDARIES.md and threat T14 are commitments about what this product
 * will not build. They are checked here rather than left to review: the shape of the
 * code — which identifiers can merge two observations, which channels exist, what the
 * camera path is allowed to do with a frame — is what makes the boundary real.
 *
 * This is a drift guard, not a proof: it cannot stop someone determined to add such a
 * feature, only make doing it by accident fail the build.
 */
/** Build output, skipped by path — unlike the bare name `release`, which is also source. */
const SKIP_PATHS = new Set([path.join(root, 'apps', 'desktop', 'release')]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (SKIP_PATHS.has(full)) continue;
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) acc.push(full);
  }
  return acc;
}

const SOURCES = ['packages', 'providers', 'apps', 'tools'].flatMap((d) => sourceFiles(path.join(root, d)));

test('boundary: identity resolution merges only on authoritative object identifiers (ADR-011)', () => {
  // A person-derived key here would turn the world model into a people index; the rule
  // names are the allowlist, and adding one is a deliberate act that fails this test.
  assert.deepEqual(
    Object.keys(authoritativeRules).sort(),
    ['aircraft', 'airport', 'earthquake', 'satellite', 'vessel'],
    'identity rules cover object types only',
  );
  const observation = { providerId: 'p', externalId: 'x', payload: {} } as never;
  for (const [type, rule] of Object.entries(authoritativeRules)) {
    const result = rule(observation);
    if (result) assert.match(result.rule, /^(?:aircraft\.icao24|vessel\.mmsi|satellite\.norad|earthquake\.usgs|airport\.icao)$/, `${type} joins on an authoritative id`);
  }
});

test('boundary: no channel searches for a person, and no recognition runs on a frame', () => {
  const personShaped = REQUEST_CHANNELS.filter((c) => /person|people|face|facial|biometr|plate|alpr|owner|subject/i.test(c));
  assert.deepEqual(personShaped, [], 'the IPC catalogue exposes no person-oriented capability');

  // The camera path may fetch, relay and display a frame. Anything that reads pixels to
  // decide what is in one is out of bounds.
  const analysisApis = /\b(?:detectFaces|faceDetect|recognize[A-Z]|FaceDetector|readPlates?|plateRecognit|tesseract|opencv|\bocr\(|classifyFrame|detectObjects)\b/;
  const offenders = SOURCES.filter((f) => analysisApis.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(root, f)), [], 'no frame-analysis API is called anywhere');
});

test('boundary: no module that handles frame bytes writes them to disk', () => {
  // The sidecar writes one file — its own generated go2rtc.yaml — and never sees a
  // frame, so it is the single exception and is named here rather than waved through.
  const FRAME_MODULES = ['relay.ts', 'direct-gateway.ts', 'go2rtc-gateway.ts', 'hub.ts', 'public-frames.ts', 'image.ts', 'fetch-adapters.ts'];
  const dir = path.join(root, 'packages', 'camera-gateway', 'src');
  const present = readdirSync(dir).filter((f) => FRAME_MODULES.includes(f));
  assert.deepEqual(present.sort(), [...FRAME_MODULES].sort(), 'a frame-handling module was renamed; update this guard');
  for (const file of present) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!/\bwriteFile(?:Sync)?\s*\(|\bcreateWriteStream\s*\(|\bappendFile/.test(text), `${file} must not persist frames`);
  }
  const sidecar = readFileSync(path.join(dir, 'go2rtc-sidecar.ts'), 'utf8');
  assert.ok(/generateConfig\(\)/.test(sidecar), 'the sidecar writes only its generated config');
});

test('boundary: the document and the threat model still state the commitment', () => {
  const doc = readFileSync(path.join(root, 'docs', 'PRODUCT-BOUNDARIES.md'), 'utf8').toLowerCase();
  for (const phrase of ['person search', 'facial recognition', 'deanonymization', 'private-device tracking', 'license-plate history']) {
    assert.ok(doc.includes(phrase), `PRODUCT-BOUNDARIES.md no longer mentions ${phrase}`);
  }
  const threats = readFileSync(path.join(root, 'docs', 'security', 'THREAT-MODEL.md'), 'utf8');
  assert.match(threats, /### T14 Misuse against a private individual/);
});

/**
 * Every file a `pnpm` script executes must be in the repository.
 *
 * `.gitignore` carried a bare `release/`, which matches a directory of that name at any
 * depth — so as well as apps/desktop/release (the build output it was written for) it
 * excluded tools/release, the SBOM and release-verification tooling. Eight source files
 * were never committed. Nothing noticed, because they existed on the machine that wrote
 * them and on no other: `pnpm sbom` worked there and failed in CI with
 * `Cannot find module /home/runner/work/oneview/oneview/tools/release/src/sbom-cli.ts`,
 * and `pnpm release:verify` could never have run on a fresh clone at all.
 *
 * This is the whole class of defect in one line: a check that passes locally because the
 * local machine has something the repository does not. Asking git what it tracks, rather
 * than asking the filesystem what exists, is the only version of this test that works.
 */
test('every pnpm script entry point is tracked by git', () => {
  const scripts = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  const untracked: string[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const token of command.match(/[\w./-]+\.(?:ts|mjs|js|cjs)/g) ?? []) {
      if (!existsSync(path.join(root, token))) continue; // not a path in this repo
      const shown = spawnSync('git', ['ls-files', '--error-unmatch', token], { cwd: root });
      if (shown.status !== 0) untracked.push(`pnpm ${name} → ${token}`);
    }
  }
  assert.deepEqual(untracked, [], 'these scripts run files that a fresh clone would not have');
});
