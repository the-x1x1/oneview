#!/usr/bin/env node
/** pnpm license-audit — verifies manifests against the legal registries; fails closed. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLicenseAudit, formatAudit } from './audit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const report = runLicenseAudit(root);
mkdirSync(path.join(root, 'artifacts', 'verification'), { recursive: true });
writeFileSync(
  path.join(root, 'artifacts', 'verification', 'license-audit.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatAudit(report));
process.exit(report.passed ? 0 : 1);
