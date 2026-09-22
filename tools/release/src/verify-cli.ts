#!/usr/bin/env node
/** pnpm release:verify — assembles artifacts/release/verification-report.json + SHA256SUMS.txt. */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVerificationReport, formatVerification, sha256SumsText } from './verify.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const release = (JSON.parse(readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8')) as { version: string }).version;
const report = buildVerificationReport({ root, release });
const outDir = path.join(root, 'artifacts', 'release');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'verification-report.json'), JSON.stringify(report, null, 2) + '\n');
if (report.artifactHashes.length) writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sha256SumsText(report.artifactHashes));
console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatVerification(report));
// The gate fails on real failures only; "not verified here" is reported, never silently passed.
process.exit(report.passed ? 0 : 1);
