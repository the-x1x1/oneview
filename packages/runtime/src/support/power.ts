import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PowerStatus } from '@worldview/ipc-contract';

/**
 * Battery and mains power, read from Linux sysfs only (docs/cyberdeck M5): the files the kernel
 * keeps under /sys/class/power_supply, read when asked. No daemon, no D-Bus, nothing privileged,
 * nothing on a timer here. Off Linux the host's own on-battery flag (Electron's powerMonitor) is
 * all there is, and the percentage is unknown.
 *
 * Several batteries (some ThinkPads carry two) are added up by their energy where the kernel
 * gives it, else averaged. A USB-C power bank shows up as mains or a "USB" supply that is online.
 */

export type { PowerStatus };

async function readText(file: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function readPower(opts: { sysRoot?: string; onBattery?: boolean } = {}): Promise<PowerStatus> {
  const dir = path.join(opts.sysRoot ?? '/sys', 'class', 'power_supply');
  const names = (await fs.readdir(dir).catch(() => [] as string[])).sort();
  let externalOnline = false;
  let externalSeen = false;
  // Per battery: its energy pair (µWh), else its charge pair (µAh) — never one of each.
  const stores: Array<{ unit: 'energy' | 'charge'; now: number; full: number }> = [];
  let allStored = true;
  let batteries = 0;
  const capacities: number[] = [];
  let charging = false;
  let discharging = false;
  for (const name of names) {
    const d = path.join(dir, name);
    const type = await readText(path.join(d, 'type'));
    if (type === 'Mains' || type === 'USB' || type === 'USB_C' || type === 'USB_PD') {
      externalSeen = true;
      if ((await readText(path.join(d, 'online'))) === '1') externalOnline = true;
      continue;
    }
    if (type !== 'Battery') continue;
    // Peripherals (a mouse, a headset) report as batteries with scope "Device": not this computer's.
    if ((await readText(path.join(d, 'scope'))) === 'Device') continue;
    if ((await readText(path.join(d, 'present'))) === '0') continue;
    batteries++;
    const status = await readText(path.join(d, 'status'));
    if (status === 'Charging') charging = true;
    if (status === 'Discharging') discharging = true;
    const cap = num(await readText(path.join(d, 'capacity')));
    if (cap !== undefined) capacities.push(Math.max(0, Math.min(100, cap)));
    const eNow = num(await readText(path.join(d, 'energy_now')));
    const eFull = num(await readText(path.join(d, 'energy_full')));
    const cNow = num(await readText(path.join(d, 'charge_now')));
    const cFull = num(await readText(path.join(d, 'charge_full')));
    if (eNow !== undefined && eFull !== undefined && eFull > 0) stores.push({ unit: 'energy', now: eNow, full: eFull });
    else if (cNow !== undefined && cFull !== undefined && cFull > 0)
      stores.push({ unit: 'charge', now: cNow, full: cFull });
    else allStored = false;
  }
  const out: PowerStatus = { source: 'unknown' };
  if (batteries === 0) out.noBattery = true;
  // Weighted by what each holds only when every battery reports in the same unit; otherwise
  // the kernel's own percentages, averaged.
  const oneUnit = stores.length > 0 && stores.every((x) => x.unit === stores[0]!.unit);
  if (allStored && oneUnit && stores.length === batteries) {
    const full = stores.reduce((a, x) => a + x.full, 0);
    out.batteryPct = Math.round((stores.reduce((a, x) => a + x.now, 0) / full) * 100);
  } else if (capacities.length) out.batteryPct = Math.round(capacities.reduce((a, b) => a + b, 0) / capacities.length);
  if (out.batteryPct !== undefined) out.batteryPct = Math.max(0, Math.min(100, out.batteryPct));
  if (charging) out.charging = true;
  if (externalSeen) out.source = externalOnline ? 'ac' : 'battery';
  else if (discharging) out.source = 'battery';
  else if (charging) out.source = 'ac';
  // Nothing in sysfs said: the host's own flag, if it has one.
  else if (opts.onBattery !== undefined) out.source = opts.onBattery ? 'battery' : 'ac';
  return out;
}

/** "Battery 64%, charging" / "On mains, battery 100%" / "Battery 18%" / "Mains power" */
export function powerText(p: PowerStatus): string {
  const pct = p.batteryPct !== undefined ? `${p.batteryPct}%` : undefined;
  if (p.source === 'ac') return pct ? `On mains, battery ${pct}${p.charging ? ', charging' : ''}` : 'Mains power';
  if (p.source === 'battery') return pct ? `Battery ${pct}` : 'On battery';
  return pct ? `Battery ${pct}` : 'Power unknown';
}
