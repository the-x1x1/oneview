#!/usr/bin/env node
/**
 * pnpm provider:record <provider-dir> [--scenario normal] [--out fixtures/<dir>/recorded]
 *
 * Records a real provider payload into `fixtures/<dir>/recorded/` so a contract fixture
 * can be refreshed from the live source. Recording is deliberately conservative:
 *
 *  - it refuses providers whose data policy forbids raw payload retention
 *    (`rawPayloadRetentionAllowed: false`) or redistribution — those keep synthetic
 *    contract fixtures instead (directive §93);
 *  - it only contacts hosts the manifest already allowlists, through the same
 *    HttpClient the runtime uses (timeouts, size caps, allowlist, redaction);
 *  - credentials are read from the environment (`WORLDVIEW_CRED_<KEY>`), never written
 *    into the recording, and any query-string secret is redacted from the saved
 *    metadata;
 *  - the recording carries a metadata sidecar (URL with secrets stripped, timestamp,
 *    status, byte count, sha256) so a fixture's provenance is auditable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HttpClient, LoggerHub, ConsoleSink, redactText } from '@worldview/core';
import { systemClock } from '@worldview/world-model';
import type { ProviderManifest } from '@worldview/provider-sdk';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!dir) {
  console.error('usage: pnpm provider:record <provider-dir> [--url <url>] [--scenario normal] [--out <dir>]');
  process.exit(2);
}

const manifestModule = (await import(
  pathToFileURL(path.join(root, 'providers', dir, 'src', 'manifest.ts')).href
)) as Record<string, unknown>;
const manifest = Object.values(manifestModule).find(
  (v): v is ProviderManifest => typeof v === 'object' && v !== null && 'id' in v && 'dataPolicy' in v,
);
if (!manifest) {
  console.error(`providers/${dir}/src/manifest.ts does not export a ProviderManifest`);
  process.exit(2);
}

if (!manifest.dataPolicy.rawPayloadRetentionAllowed) {
  console.error(
    `${manifest.id}: the data policy forbids raw payload retention — keep the synthetic contract fixtures (docs/providers/BUILDING-A-PROVIDER.md).`,
  );
  process.exit(3);
}
if (!manifest.dataPolicy.redistributionAllowed) {
  console.error(
    `${manifest.id}: the data policy forbids redistribution — a recorded payload could not be committed. Keep synthetic fixtures.`,
  );
  process.exit(3);
}

const url = flag('url');
if (!url) {
  console.error(`No --url given. ${manifest.id} allows: ${manifest.allowedHosts.join(', ')}`);
  process.exit(2);
}

const hub = new LoggerHub({ level: 'info', sinks: [new ConsoleSink()] });
const client = new HttpClient({
  allowedHosts: manifest.allowedHosts,
  clock: systemClock,
  logger: hub.logger('provider', { providerId: manifest.id }),
  userAgent: `WorldView/0.1 provider-recorder (+https://github.com/the-x1x1/oneview)`,
  defaultTimeoutMs: Math.max(manifest.refreshPolicy.timeoutMs, 30_000),
  maxRetries: 1,
  credentials: {
    get: async (key: string) => process.env[`WORLDVIEW_CRED_${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`],
  },
});

const scenario = flag('scenario') ?? 'normal';
const outDir = flag('out') ?? path.join(root, 'fixtures', dir, 'recorded');

try {
  const credential = manifest.credentials[0];
  const res = await client.request({
    url,
    ...(credential
      ? { credential: { key: credential.key, as: 'query' as const, name: credential.key.split('.').pop() ?? 'key' } }
      : {}),
  });
  const body = res.bytes();
  const ext =
    /json/.test(res.headers['content-type'] ?? '') || url.endsWith('.json') || url.endsWith('.geojson')
      ? 'json'
      : /csv/.test(res.headers['content-type'] ?? '')
        ? 'csv'
        : 'txt';
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${scenario}.${ext}`);
  writeFileSync(file, body);
  writeFileSync(
    path.join(outDir, `${scenario}.meta.json`),
    JSON.stringify(
      {
        providerId: manifest.id,
        recordedAt: new Date().toISOString(),
        url: redactText(url),
        status: res.status,
        bytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
        contentType: res.headers['content-type'] ?? null,
        attribution: manifest.attribution.text,
        license: manifest.attribution.licenseId ?? null,
        note: 'Recorded payload. Committing it is allowed only because the provider data policy permits raw retention and redistribution.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`[record] ${manifest.id} ${res.status} ${body.byteLength} bytes → ${path.relative(root, file)}`);
} catch (err) {
  console.error(`[record] failed: ${err instanceof Error ? redactText(err.message) : String(err)}`);
  process.exit(1);
}
