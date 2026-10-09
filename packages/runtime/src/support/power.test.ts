import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { powerText, readPower } from './power.js';

/** A fake /sys/class/power_supply laid out as the kernel does (values invented). */
async function sysfs(supplies: Record<string, Record<string, string>>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-power-'));
  for (const [name, files] of Object.entries(supplies)) {
    const d = path.join(root, 'class', 'power_supply', name);
    await fs.mkdir(d, { recursive: true });
    for (const [f, v] of Object.entries(files)) await fs.writeFile(path.join(d, f), `${v}\n`);
  }
  return root;
}

test('power: a laptop on battery, and charging on mains', async () => {
  const onBattery = await sysfs({
    AC: { type: 'Mains', online: '0' },
    BAT0: {
      type: 'Battery',
      present: '1',
      status: 'Discharging',
      capacity: '64',
      energy_now: '33000000',
      energy_full: '51000000',
    },
  });
  const p = await readPower({ sysRoot: onBattery });
  assert.deepEqual(p, { source: 'battery', batteryPct: 65 });
  assert.equal(powerText(p), 'Battery 65%');

  const charging = await sysfs({
    AC: { type: 'Mains', online: '1' },
    BAT0: { type: 'Battery', status: 'Charging', capacity: '80' },
  });
  const c = await readPower({ sysRoot: charging });
  assert.deepEqual(c, { source: 'ac', batteryPct: 80, charging: true });
  assert.equal(powerText(c), 'On mains, battery 80%, charging');
});

test('power: two batteries by energy; a USB-C power bank counts as external power; a mouse is not this computer', async () => {
  const root = await sysfs({
    BAT0: { type: 'Battery', status: 'Discharging', capacity: '90', energy_now: '9000000', energy_full: '10000000' },
    BAT1: { type: 'Battery', status: 'Discharging', capacity: '10', energy_now: '3000000', energy_full: '30000000' },
    hidpp_battery_0: { type: 'Battery', scope: 'Device', status: 'Discharging', capacity: '5' },
    ucsi: { type: 'USB', online: '1' },
  });
  assert.deepEqual(await readPower({ sysRoot: root }), { source: 'ac', batteryPct: 30 });
});

test('power: no batteries (a desktop or a container); the host flag decides the source', async () => {
  const none = await sysfs({});
  assert.deepEqual(await readPower({ sysRoot: none }), { source: 'unknown', noBattery: true });
  assert.deepEqual(await readPower({ sysRoot: none, onBattery: false }), { source: 'ac', noBattery: true });
  assert.deepEqual(await readPower({ sysRoot: path.join(none, 'missing'), onBattery: true }), {
    source: 'battery',
    noBattery: true,
  });
  assert.equal(powerText({ source: 'battery' }), 'On battery');
  assert.equal(powerText({ source: 'unknown' }), 'Power unknown');
});

test('power: units are never mixed — one battery in energy, one in charge, falls back to the percentages', async () => {
  const root = await sysfs({
    BAT0: { type: 'Battery', status: 'Discharging', capacity: '90', energy_now: '9000000', energy_full: '10000000' },
    BAT1: { type: 'Battery', status: 'Discharging', capacity: '10', charge_now: '300000', charge_full: '3000000' },
  });
  assert.deepEqual(await readPower({ sysRoot: root }), { source: 'battery', batteryPct: 50 });
  // A battery that reports nothing usable is still a battery: not "no battery".
  const bare = await sysfs({ BAT0: { type: 'Battery', status: 'Unknown' } });
  assert.deepEqual(await readPower({ sysRoot: bare, onBattery: true }), { source: 'battery' });
});
