import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalAccess } from './provider-storage.js';

/**
 * The granted folder (ADR-003 amendment 2026-09-23): reads and stats stay inside the folder
 * the function answers at the time of the call, so a folder the user renames in settings
 * applies to the next read without a restart, and clearing it refuses the next read.
 */
test('granted folder: reads and stats inside the current grant; escapes, directories, a cleared grant refused', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wv-grant-'));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  mkdirSync(path.join(a, 'sub'), { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(path.join(a, 'sub', 'points.geojson'), '{"type":"FeatureCollection","features":[]}');
  writeFileSync(path.join(b, 'other.csv'), 'id,lat,lon\n');
  utimesSync(path.join(a, 'sub', 'points.geojson'), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  let grant: string | undefined = a;
  const access = createLocalAccess({ allowedHosts: [], grantDir: () => grant });

  const bytes = await access.readGrantedFile('sub/points.geojson');
  assert.equal(Buffer.from(bytes).toString(), '{"type":"FeatureCollection","features":[]}');
  const stat = await access.statGrantedFile!('sub/points.geojson');
  assert.equal(stat.size, bytes.byteLength);
  assert.equal(Math.round(stat.mtimeMs), 1_700_000_000_000);

  await assert.rejects(
    access.readGrantedFile('../b/other.csv'),
    (e: Error & { code?: string }) => e.code === 'HOST_NOT_ALLOWED',
  );
  await assert.rejects(
    access.readGrantedFile(path.join(b, 'other.csv')),
    (e: Error & { code?: string }) => e.code === 'HOST_NOT_ALLOWED',
  );
  await assert.rejects(access.statGrantedFile!('sub'), (e: Error & { code?: string }) => /not a file/.test(e.message));
  await assert.rejects(
    access.readGrantedFile('sub/missing.geojson'),
    (e: Error & { code?: string }) => e.code === 'UNSUPPORTED',
  );
  await assert.rejects(
    access.readGrantedFile('sub/points.geojson', { maxBytes: 4 }),
    (e: Error & { code?: string }) => e.code === 'TOO_LARGE',
  );

  grant = b;
  assert.equal(
    Buffer.from(await access.readGrantedFile('other.csv')).toString(),
    'id,lat,lon\n',
    'the new folder applies at once',
  );
  await assert.rejects(
    access.readGrantedFile('sub/points.geojson'),
    (e: Error & { code?: string }) => e.code === 'UNSUPPORTED',
  );

  grant = undefined;
  await assert.rejects(access.readGrantedFile('other.csv'), (e: Error & { code?: string }) => e.code === 'UNSUPPORTED');
  rmSync(root, { recursive: true, force: true });
});
