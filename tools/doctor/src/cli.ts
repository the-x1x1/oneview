#!/usr/bin/env node
/** pnpm doctor — environment and configuration checks (directive §84). */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, formatDoctor } from './checks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const report = await runDoctor({
  root,
  ...(arg('user-data') ? { userDataDir: arg('user-data')! } : {}),
  ...(arg('go2rtc') ? { go2rtcPath: arg('go2rtc')! } : {}),
  ...(arg('readsb') ? { readsbEndpoint: arg('readsb')! } : {}),
  probe: async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return { reachable: true, status: res.status };
    } catch {
      return { reachable: false };
    }
  },
});
mkdirSync(path.join(root, 'artifacts', 'verification'), { recursive: true });
writeFileSync(path.join(root, 'artifacts', 'verification', 'doctor.json'), JSON.stringify(report, null, 2) + '\n');
console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatDoctor(report));
process.exit(report.passed ? 0 : 1);
