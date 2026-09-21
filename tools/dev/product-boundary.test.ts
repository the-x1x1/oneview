import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUEST_CHANNELS } from '@worldview/ipc-contract';
import { authoritativeRules } from '@worldview/identity';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'dist', 'out', 'release', '.vite', 'build-output', '.git', '.claude', 'artifacts', 'fixtures']);

/**
 * docs/PRODUCT-BOUNDARIES.md and threat T14 are commitments about what this product
 * will not build. They are checked here rather than left to review: the shape of the
 * code — which identifiers can merge two observations, which channels exist, what the
 * camera path is allowed to do with a frame — is what makes the boundary real.
 *
 * This is a drift guard, not a proof: it cannot stop someone determined to add such a
 * feature, only make doing it by accident fail the build.
 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
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
