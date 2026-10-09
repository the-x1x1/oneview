import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FieldHostStatus } from '@worldview/ipc-contract';
import { settle, startRuntime } from '../helpers/harness.js';

/** A fake /sys with one laptop battery (values invented). */
async function fakeSys(capacity: string, acOnline: '0' | '1'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-field-sys-'));
  const ps = path.join(root, 'class', 'power_supply');
  await fs.mkdir(path.join(ps, 'AC'), { recursive: true });
  await fs.writeFile(path.join(ps, 'AC', 'type'), 'Mains\n');
  await fs.writeFile(path.join(ps, 'AC', 'online'), `${acOnline}\n`);
  await fs.mkdir(path.join(ps, 'BAT0'), { recursive: true });
  await fs.writeFile(path.join(ps, 'BAT0', 'type'), 'Battery\n');
  await fs.writeFile(path.join(ps, 'BAT0', 'status'), acOnline === '1' ? 'Charging\n' : 'Discharging\n');
  await fs.writeFile(path.join(ps, 'BAT0', 'capacity'), `${capacity}\n`);
  return root;
}

test('field status: battery and disk headroom on request; power changes and waking are pushed', async () => {
  const sys = await fakeSys('47', '0');
  const h = await startRuntime({ platform: 'linux', powerSysRoot: sys });
  try {
    const st = await h.client.request('field.status', undefined);
    assert.deepEqual(st.power, { source: 'battery', batteryPct: 47 });
    assert.ok(st.appDisk && st.appDisk.totalBytes > 0 && st.appDisk.freeBytes >= 0, 'disk headroom read');
    assert.equal(st.resumedAt, undefined);

    const pushed: FieldHostStatus[] = [];
    h.runtime.on('field.changed', (s) => pushed.push(s));
    h.runtime.setPowerSource?.(true);
    h.runtime.setPowerSource?.(true); // no change: nothing pushed
    for (let i = 0; i < 100 && pushed.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await settle();
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0]!.power.source, 'battery');

    await h.runtime.notifyResume?.();
    assert.equal(pushed.length, 2);
    assert.equal(pushed[1]!.resumedAt, new Date(h.clock.now()).toISOString());
  } finally {
    await h.dispose();
  }
});

test('field status off Linux: only the host flag, never a made-up percentage', async () => {
  const h = await startRuntime({ platform: 'win32' });
  try {
    assert.deepEqual((await h.client.request('field.status', undefined)).power, { source: 'unknown' });
    h.runtime.setPowerSource?.(false);
    assert.deepEqual((await h.client.request('field.status', undefined)).power, { source: 'ac' });
  } finally {
    await h.dispose();
  }
});

test('field profile: internet sources slowed to a third, back to normal when the profile changes', async () => {
  const h = await startRuntime({});
  try {
    const host = h.runtime.core.providerHost;
    assert.equal(host.pollIntervalScale, 1, 'balanced by default');
    const settings = await h.client.request('settings.get', undefined);
    await h.client.request('settings.set', { display: { ...settings.display, profile: 'field' } });
    assert.equal(host.pollIntervalScale, 3);
    await h.client.request('settings.set', { display: { ...settings.display, profile: 'docked' } });
    assert.equal(host.pollIntervalScale, 1);
  } finally {
    await h.dispose();
  }
});
