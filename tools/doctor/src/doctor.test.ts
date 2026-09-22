import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, formatDoctor } from './checks.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('doctor reports honest skips and fails on missing bundled data', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wv-doctor-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.28.0' }));
    mkdirSync(path.join(dir, 'config', 'licenses'), { recursive: true });
    writeFileSync(path.join(dir, 'config', 'licenses', 'providers.json'), JSON.stringify({ records: [] }));
    const report = await runDoctor({ root: dir, userDataDir: path.join(dir, 'userdata'), now: () => 0 });
    const byName = new Map(report.checks.map((c) => [c.name, c]));
    assert.equal(byName.get('Dependencies installed')?.status, 'skip');
    assert.equal(byName.get('Bundled airports dataset')?.status, 'fail');
    assert.equal(byName.get('User data directory writable')?.status, 'pass');
    assert.equal(byName.get('go2rtc sidecar')?.status, 'skip');
    assert.equal(report.passed, false);
    assert.match(formatDoctor(report), /PROBLEMS FOUND/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor probes a configured readsb endpoint instead of scanning', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wv-doctor-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.28.0' }));
    mkdirSync(path.join(dir, 'apps', 'desktop', 'resources', 'data'), { recursive: true });
    writeFileSync(
      path.join(dir, 'apps', 'desktop', 'resources', 'data', 'airports.geojson'),
      JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature' }] }),
    );
    mkdirSync(path.join(dir, 'config', 'licenses'), { recursive: true });
    writeFileSync(
      path.join(dir, 'config', 'licenses', 'providers.json'),
      JSON.stringify({ records: [{ providerId: 'x' }] }),
    );
    const probed: string[] = [];
    const report = await runDoctor({
      root: dir,
      userDataDir: path.join(dir, 'userdata'),
      readsbEndpoint: 'http://127.0.0.1:8080/data/aircraft.json',
      probe: async (url) => {
        probed.push(url);
        return { reachable: false };
      },
      now: () => 0,
    });
    assert.deepEqual(probed, ['http://127.0.0.1:8080/data/aircraft.json']);
    assert.equal(report.checks.find((c) => c.name === 'Local readsb receiver')?.status, 'warn');
    assert.equal(report.checks.find((c) => c.name === 'Bundled airports dataset')?.status, 'pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor runs against the repository without failing checks', async () => {
  const report = await runDoctor({
    root: repoRoot,
    userDataDir: mkdtempSync(path.join(tmpdir(), 'wv-doctor-data-')),
    now: () => 0,
  });
  const failures = report.checks.filter((c) => c.status === 'fail');
  assert.deepEqual(
    failures.map((f) => `${f.name}: ${f.detail}`),
    [],
  );
});

test("doctor reads the go2rtc path from an installation's settings and checks the file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wv-doctor-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.28.0' }));
    mkdirSync(path.join(dir, 'config', 'licenses'), { recursive: true });
    writeFileSync(path.join(dir, 'config', 'licenses', 'providers.json'), JSON.stringify({ records: [] }));
    const userData = path.join(dir, 'userdata');
    mkdirSync(userData, { recursive: true });
    const settingsFile = path.join(userData, 'settings.json');
    const write = (go2rtcPath: string) =>
      writeFileSync(settingsFile, JSON.stringify({ schemaVersion: 1, settings: { cameras: { go2rtcPath } } }));
    const check = async () =>
      (await runDoctor({ root: dir, userDataDir: userData, now: () => 0 })).checks.find(
        (c) => c.name === 'go2rtc sidecar',
      );

    write('');
    assert.equal((await check())?.status, 'skip', 'an empty path is not configured, not a failure');

    write(path.join(dir, 'nowhere', 'go2rtc'));
    const missing = await check();
    assert.equal(missing?.status, 'fail');
    assert.match(missing?.detail ?? '', /not found/);

    write('go2rtc');
    const relative = await check();
    assert.equal(relative?.status, 'fail', 'the runtime refuses a relative path, so the doctor says so');
    assert.match(relative?.detail ?? '', /absolute/);

    const binary = path.join(dir, 'go2rtc');
    writeFileSync(binary, '#!/bin/sh\n');
    write(binary);
    assert.equal((await check())?.status, 'pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
