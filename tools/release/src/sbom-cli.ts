#!/usr/bin/env node
/** pnpm sbom — writes artifacts/release/WorldView-<version>.sbom.json (CycloneDX 1.5). */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildSbom } from './sbom.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const version = (JSON.parse(readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8')) as { version: string }).version;
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
const sbom = buildSbom({ root, version, commit, includeDev: process.argv.includes('--include-dev') });
const out = path.join(root, 'artifacts', 'release', `WorldView-${version}.sbom.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(sbom, null, 2) + '\n');
console.log(`[sbom] ${sbom.components.length} components → ${path.relative(root, out)}`);
for (const p of sbom.metadata.properties) console.log(`       ${p.name}: ${p.value}`);
