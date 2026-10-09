import type { FieldHostStatus, VaultHealthSummary } from '@worldview/ipc-contract';
import type { ConnectionSnapshot, SourceHealthEntry } from '@worldview/source-health';

/**
 * The field status strip (docs/cyberdeck M5), as data: one short item each for the network,
 * this computer's GPS, the aircraft receiver, the mesh, the data vault, disk headroom and power.
 * Pure, so every wording is tested; the component only draws it.
 *
 * "Connected" and "data received" are kept apart: a receiver can answer and hear nothing. Each
 * receiver item says both — whether its source is up, and how long ago data last arrived.
 */

export type FieldTone = 'ok' | 'warn' | 'bad' | 'off';

export interface FieldItem {
  id: 'network' | 'gps' | 'adsb' | 'mesh' | 'vault' | 'disk' | 'power';
  label: string;
  value: string;
  tone: FieldTone;
  /** Longer wording for the tooltip and screen readers. */
  title: string;
  /** A source on this computer the strip can switch on and off in one click. */
  source?: { providerId: string; enabled: boolean };
}

export interface FieldInput {
  workOffline: boolean;
  connection: ConnectionSnapshot | null;
  entries: readonly SourceHealthEntry[];
  vaults?: readonly VaultHealthSummary[] | undefined;
  field: FieldHostStatus | null;
}

/** As providers/meshtastic-local OWN_FIX_FRESH_SECONDS (the renderer does not import providers). */
const OWN_FIX_FRESH_MS = 300_000;
/**
 * A connected receiver with nothing new for this long is amber: aircraft overhead are heard
 * every second, so ten minutes of silence is worth a look; mesh nodes report every 15 minutes
 * by default, so an hour.
 */
const RECEIVER_SILENT_MS = { adsb: 10 * 60_000, mesh: 60 * 60_000 } as const;
const GB = 1024 ** 3;

export function shortAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

function gb(bytes: number): string {
  const g = bytes / GB;
  return g >= 100 ? `${Math.round(g)} GB` : `${g.toFixed(1)} GB`;
}

function since(iso: string | undefined, nowMs: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? nowMs - t : undefined;
}

function networkItem(i: FieldInput): FieldItem {
  if (i.workOffline)
    return {
      id: 'network',
      label: 'NET',
      value: 'LOCAL',
      tone: 'ok',
      title: 'Work offline: nothing is asked of the internet; sources on this computer keep running',
    };
  const state = i.connection?.state;
  if (state === 'OFFLINE')
    return {
      id: 'network',
      label: 'NET',
      value: 'OFFLINE',
      tone: 'warn',
      title: i.connection?.networkOnline === false ? 'No network' : 'Internet sources unreachable',
    };
  if (state === 'DEGRADED')
    return { id: 'network', label: 'NET', value: 'DEGRADED', tone: 'warn', title: 'Some internet sources failing' };
  return { id: 'network', label: 'NET', value: 'ONLINE', tone: 'ok', title: 'Connected to the internet' };
}

function gpsItem(mesh: SourceHealthEntry | undefined, nowMs: number): FieldItem {
  const base = { id: 'gps' as const, label: 'GPS' };
  if (!mesh || !mesh.enabled)
    return {
      ...base,
      value: 'no source',
      tone: 'off',
      title: "This computer's position comes from a Meshtastic node plugged in by USB",
    };
  if (mesh.health.status === 'STARTING')
    return { ...base, value: 'starting', tone: 'warn', title: 'Connecting to the Meshtastic node' };
  if (mesh.health.status !== 'LIVE')
    return {
      ...base,
      value: 'no node',
      tone: 'bad',
      title: mesh.health.message ?? 'The Meshtastic node is not connected',
    };
  const own = mesh.health.ownPosition;
  if (!own) return { ...base, value: 'waiting', tone: 'warn', title: 'Waiting for the node to say which node it is' };
  const node = own.node ? ` (${own.node})` : '';
  if (own.state === 'no-fix' || own.state === 'not-gnss')
    return {
      ...base,
      value: 'NO FIX',
      tone: 'bad',
      title: `No GPS fix on this computer's node${node}: no position is shown`,
    };
  if (own.state === 'manual')
    return {
      ...base,
      value: 'set by hand',
      tone: 'warn',
      title: `A fixed position typed into the node${node}, not GPS`,
    };
  const age = since(own.fixAt, nowMs);
  const detail = [own.fixType, own.satellites !== undefined ? `${own.satellites} satellites` : undefined]
    .filter(Boolean)
    .join(', ');
  const acc = own.accuracyM !== undefined ? `, ±${own.accuracyM} m` : '';
  if (own.state === 'unknown-age' || age === undefined || age < -OWN_FIX_FRESH_MS)
    return {
      ...base,
      value: 'age unknown',
      tone: 'warn',
      title: `GPS fix${node} dated ahead of this computer's clock: its age cannot be told${acc}`,
    };
  const stale = age > OWN_FIX_FRESH_MS;
  return {
    ...base,
    value: `${stale ? 'STALE ' : ''}${own.fixType ?? 'fix'} ${shortAgo(age)}`,
    tone: stale ? 'warn' : 'ok',
    title: `${stale ? 'Stale GPS fix' : 'GPS fix'}${node}${detail ? ` (${detail})` : ''}, ${shortAgo(age)} old${acc}`,
  };
}

/** A receiver on this computer: connected or not, and data received or not, said separately. */
function receiverItem(
  id: 'adsb' | 'mesh',
  label: string,
  entry: SourceHealthEntry | undefined,
  unit: [string, string],
  nowMs: number,
): FieldItem | undefined {
  if (!entry) return undefined;
  const source = { providerId: entry.providerId, enabled: entry.enabled };
  if (!entry.enabled) return { id, label, value: 'off', tone: 'off', title: `${entry.name}: off`, source };
  const h = entry.health;
  if (h.status === 'STARTING') return { id, label, value: 'starting', tone: 'warn', title: entry.name, source };
  if (h.status === 'NEEDS_SETUP')
    return {
      id,
      label,
      value: 'set up',
      tone: 'warn',
      title: `${entry.name}: ${h.message ?? 'needs setting up'}`,
      source,
    };
  if (h.status !== 'LIVE')
    return {
      id,
      label,
      value: id === 'adsb' ? 'not detected' : 'no node',
      tone: 'bad',
      title: `${entry.name}: ${h.message ?? h.status}`,
      source,
    };
  const n = h.objectCount ?? 0;
  const ago = since(h.lastObservation, nowMs);
  const count = `${n} ${n === 1 ? unit[0] : unit[1]}`;
  if (ago === undefined)
    return {
      id,
      label,
      value: 'no data yet',
      tone: 'warn',
      title: `${entry.name}: connected, nothing received yet`,
      source,
    };
  // Connected but silent for a long while is not shown as all well.
  const silent = ago > RECEIVER_SILENT_MS[id];
  return {
    id,
    label,
    value: `${count} · ${shortAgo(ago)}`,
    tone: silent ? 'warn' : 'ok',
    title: `${entry.name}: connected; ${count}; last data ${shortAgo(ago)} ago${silent ? ' — nothing new since' : ''}`,
    source,
  };
}

const VAULT_RANK: Record<VaultHealthSummary['state'], number> = {
  error: 0,
  foreign: 1,
  absent: 2,
  'read-only': 3,
  'low-space': 4,
  ready: 5,
};

function vaultItem(vaults: readonly VaultHealthSummary[] | undefined): FieldItem | undefined {
  if (!vaults?.length) return undefined;
  const worst = [...vaults].sort((a, b) => VAULT_RANK[a.state] - VAULT_RANK[b.state])[0]!;
  const more = vaults.length > 1 ? ` (+${vaults.length - 1})` : '';
  const free = worst.freeBytes !== undefined ? ` · ${gb(worst.freeBytes)}` : '';
  const tone: FieldTone =
    worst.state === 'ready' ? 'ok' : worst.state === 'low-space' || worst.state === 'read-only' ? 'warn' : 'bad';
  const value = worst.state === 'ready' ? `ready${free}` : worst.state === 'absent' ? 'ABSENT' : worst.state;
  return { id: 'vault', label: 'VAULT', value: `${value}${more}`, tone, title: `${worst.label}: ${worst.message}` };
}

function diskItem(field: FieldHostStatus | null): FieldItem | undefined {
  const d = field?.appDisk;
  if (!d) return undefined;
  const tone: FieldTone = d.freeBytes < 2 * GB ? 'bad' : d.freeBytes < 10 * GB ? 'warn' : 'ok';
  return {
    id: 'disk',
    label: 'DISK',
    value: gb(d.freeBytes),
    tone,
    title: `${gb(d.freeBytes)} free of ${gb(d.totalBytes)} where WORLDVIEW keeps its data`,
  };
}

function powerItem(field: FieldHostStatus | null): FieldItem | undefined {
  const p = field?.power;
  if (!p || p.source === 'unknown') return undefined;
  const pct = p.batteryPct;
  if (p.source === 'ac')
    return {
      id: 'power',
      label: 'PWR',
      value: pct !== undefined ? `AC ${pct}%${p.charging ? ' ↑' : ''}` : 'AC',
      tone: 'ok',
      title: pct !== undefined ? `On mains, battery ${pct}%${p.charging ? ', charging' : ''}` : 'On mains power',
    };
  const tone: FieldTone = pct === undefined ? 'warn' : pct < 10 ? 'bad' : pct < 20 ? 'warn' : 'ok';
  return {
    id: 'power',
    label: 'PWR',
    value: pct !== undefined ? `BAT ${pct}%` : 'BAT',
    tone,
    title: pct !== undefined ? `On battery, ${pct}%` : 'On battery',
  };
}

export function fieldStatusItems(i: FieldInput, nowMs: number): FieldItem[] {
  const byId = (id: string) => i.entries.find((e) => e.providerId === id);
  const mesh = byId('meshtastic-local');
  return [
    networkItem(i),
    gpsItem(mesh, nowMs),
    receiverItem('adsb', 'ADS-B', byId('readsb-local'), ['aircraft', 'aircraft'], nowMs),
    receiverItem('mesh', 'MESH', mesh, ['node', 'nodes'], nowMs),
    vaultItem(i.vaults),
    diskItem(i.field),
    powerItem(i.field),
  ].filter((x): x is FieldItem => x !== undefined);
}
