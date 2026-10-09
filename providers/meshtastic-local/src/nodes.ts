import type { JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import {
  LOC_EXTERNAL,
  LOC_INTERNAL,
  LOC_MANUAL,
  LOC_UNSET,
  PORT_NODEINFO,
  PORT_POSITION,
  PORT_TELEMETRY,
  nodeId,
  readPosition,
  readTelemetry,
  readUser,
  type MeshDeviceMetrics,
  type MeshEnvironment,
  type MeshNodeInfo,
  type MeshPacket,
  type MeshPosition,
  type MeshUser,
} from './wire.js';

/** Nodes remembered at most; the one heard least recently is forgotten first. */
export const MAX_NODES = 4096;

/**
 * Metres of uncertainty for a position kept to `bits` bits of precision: Meshtastic coarsens
 * a shared position by dropping low bits, 32 being full precision; 13 bits is about 2.9 km.
 */
export function precisionMetres(bits: number | undefined): number | undefined {
  if (bits === undefined || bits <= 0 || bits >= 32) return undefined;
  return Math.round(23_905_787.925 / 2 ** bits);
}

/**
 * A fix of this computer's own node counts as current for this long (seconds). Meshtastic reads
 * its GPS every two minutes by default; five minutes allows a missed reading. Older is STALE.
 */
export const OWN_FIX_FRESH_SECONDS = 300;

/** Meshtastic hardware model numbers of the boards a cyberdeck is likely to carry. */
const HARDWARE_NAMES: ReadonlyMap<number, string> = new Map([
  [4, 'LilyGO T-Beam'],
  [6, 'LilyGO T-Beam 0.7'],
  [12, 'LilyGO T-Beam S3'],
]);

export function hardwareName(model: number | undefined): string | undefined {
  return model === undefined ? undefined : HARDWARE_NAMES.get(model);
}

export type OwnFixState = 'fix' | 'stale' | 'unknown-age' | 'no-fix' | 'manual' | 'not-gnss';

/**
 * This computer's own position, as its own node's GPS reports it (docs/cyberdeck M4). Taken
 * only from what the connected node says about itself — never from another node. Coordinates
 * are present only for `fix`, `stale` (an old fix, labelled with its age), `unknown-age` (a fix
 * dated ahead of this computer's clock, so its age cannot be told) and `manual` (a fixed
 * position typed into the node — not a GPS reading, and labelled so).
 */
export interface OwnFix {
  state: OwnFixState;
  /** One line for the operator: "GPS fix (3D, 9 satellites), 40 s old", "NO FIX", … */
  text: string;
  latitude?: number;
  longitude?: number;
  altitudeM?: number;
  /** When the fix was taken (seconds), and how old it is now. */
  fixSec?: number;
  ageSeconds?: number;
  /** The fix time is ahead of this computer's clock by more than five minutes. */
  clockAhead?: boolean;
  /** Horizontal uncertainty (metres), only when the receiver gave enough to work it out. */
  accuracyM?: number;
  satellites?: number;
  fixType?: '2D' | '3D';
  hdop?: number;
  source?: 'own GPS' | 'external GPS' | 'GPS' | 'set by hand';
}

interface NodeState {
  num: number;
  user?: MeshUser;
  latitude?: number;
  longitude?: number;
  altitudeM?: number;
  /** When the position was fixed, if the node said (seconds). */
  positionTime?: number;
  precisionBits?: number;
  device?: MeshDeviceMetrics;
  environment?: MeshEnvironment;
  snr?: number;
  rssi?: number;
  hopsAway?: number;
  viaMqtt?: boolean;
  /** When the node was last heard (seconds): the node's own record, or a packet's receipt. */
  lastHeard?: number;
  /** The last position report as sent, kept even when it says "no position" (0/0). */
  report?: MeshPosition;
}

/** A position worth drawing: not 0/0 (no fix, or position sharing off), and on the Earth. */
function validPosition(p: MeshPosition): { latitude: number; longitude: number } | undefined {
  if (p.latitudeI === undefined || p.longitudeI === undefined) return undefined;
  if (p.latitudeI === 0 && p.longitudeI === 0) return undefined;
  const latitude = Math.round(p.latitudeI) / 1e7;
  const longitude = Math.round(p.longitudeI) / 1e7;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

/**
 * What the mesh says about each node, merged: the node list the connected node sends when
 * asked, then every position, node-info and telemetry packet it hears. Text messages and
 * every other application are skipped — the provider never reads what people send each other.
 */
export class NodeStore {
  private readonly nodes = new Map<number, NodeState>();
  /** The node this computer is connected to. */
  myNodeNum: number | undefined;

  get size(): number {
    return this.nodes.size;
  }

  /** Nodes with a position, the ones the map can show (this node only while it has a fix). */
  get placed(): number {
    let n = 0;
    for (const s of this.nodes.values()) if (s.latitude !== undefined) n++;
    const own = this.myNodeNum !== undefined ? this.nodes.get(this.myNodeNum) : undefined;
    if (own?.latitude !== undefined && evaluateOwnFix(own.report, 0).latitude === undefined) n--;
    return n;
  }

  private state(num: number): NodeState {
    const s = this.nodes.get(num) ?? { num };
    // Re-inserted so the map stays in least-recently-heard order.
    this.nodes.delete(num);
    this.nodes.set(num, s);
    if (this.nodes.size > MAX_NODES) this.nodes.delete(this.nodes.keys().next().value!);
    return s;
  }

  private setPosition(s: NodeState, p: MeshPosition): boolean {
    s.report = p;
    const at = validPosition(p);
    if (!at) return false;
    s.latitude = at.latitude;
    s.longitude = at.longitude;
    if (p.altitudeM !== undefined) s.altitudeM = p.altitudeM;
    else delete s.altitudeM;
    // A new fix without a time of its own must not carry the previous fix's time.
    const t = p.fixTime || p.time;
    if (t) s.positionTime = t;
    else delete s.positionTime;
    if (p.precisionBits !== undefined) s.precisionBits = p.precisionBits;
    else delete s.precisionBits;
    return true;
  }

  /** A node from the list the connected node sends on request. Returns its number. */
  nodeInfo(n: MeshNodeInfo): number | undefined {
    if (!n.num) return undefined;
    const s = this.state(n.num);
    if (n.user) s.user = n.user;
    if (n.position) this.setPosition(s, n.position);
    if (n.device) s.device = n.device;
    if (n.snr !== undefined && n.snr !== 0) s.snr = n.snr;
    if (n.hopsAway !== undefined) s.hopsAway = n.hopsAway;
    if (n.viaMqtt !== undefined) s.viaMqtt = n.viaMqtt;
    if (n.lastHeard) s.lastHeard = n.lastHeard;
    return n.num;
  }

  /**
   * A packet heard on the mesh. Returns the sender's number when it told something about the
   * sender (a position, a node info, telemetry); undefined for anything else, text included.
   */
  packet(p: MeshPacket, receivedSec: number): number | undefined {
    const d = p.decoded;
    if (!p.from || !d || !d.payload) return undefined;
    if (d.portnum !== PORT_POSITION && d.portnum !== PORT_NODEINFO && d.portnum !== PORT_TELEMETRY) return undefined;
    const s = this.state(p.from);
    s.lastHeard = p.rxTime || receivedSec;
    if (p.rxSnr !== undefined && p.rxSnr !== 0) s.snr = p.rxSnr;
    if (p.rxRssi !== undefined && p.rxRssi !== 0) s.rssi = p.rxRssi;
    if (p.hopStart !== undefined && p.hopLimit !== undefined && p.hopStart >= p.hopLimit)
      s.hopsAway = p.hopStart - p.hopLimit;
    if (p.viaMqtt !== undefined) s.viaMqtt = p.viaMqtt;
    if (d.portnum === PORT_POSITION) {
      // A position "from" this node that arrived over the air or through MQTT was not made by
      // this node (the sender field is not authenticated): it never becomes this computer's
      // position. This node's own reports reach the client without radio readings or hops.
      const overTheAir =
        !!p.viaMqtt ||
        (p.rxSnr ?? 0) !== 0 ||
        (p.rxRssi ?? 0) !== 0 ||
        (p.hopStart !== undefined && p.hopLimit !== undefined && p.hopStart > p.hopLimit);
      if (p.from === this.myNodeNum && overTheAir) return undefined;
      this.setPosition(s, readPosition(d.payload));
    } else if (d.portnum === PORT_NODEINFO) s.user = readUser(d.payload);
    else {
      const t = readTelemetry(d.payload);
      if (t.device) s.device = { ...s.device, ...t.device };
      if (t.environment) s.environment = { ...s.environment, ...t.environment };
    }
    return p.from;
  }

  /**
   * This computer's own node's GPS position: undefined until the node has said which node it is.
   * Only that node's own reports are read; a position heard from any other node never counts.
   */
  ownFix(nowSec: number): OwnFix | undefined {
    if (this.myNodeNum === undefined) return undefined;
    return evaluateOwnFix(this.nodes.get(this.myNodeNum)?.report, nowSec);
  }

  /** The connected node, for health: its name, board and battery. */
  ownNode():
    { id: string; name?: string; hardware?: string; batteryPct?: number; externalPower?: boolean } | undefined {
    if (this.myNodeNum === undefined) return undefined;
    const s = this.nodes.get(this.myNodeNum);
    const name = s?.user?.longName?.trim() || s?.user?.shortName?.trim();
    const hardware = hardwareName(s?.user?.hwModel);
    const b = s?.device?.batteryLevel;
    return {
      id: nodeId(this.myNodeNum),
      ...(name ? { name: name.slice(0, 200) } : {}),
      ...(hardware ? { hardware } : {}),
      ...(b !== undefined && b > 100 ? { externalPower: true } : {}),
      ...(b !== undefined && b <= 100 ? { batteryPct: b } : {}),
    };
  }

  /** Every node with something to draw (a full snapshot, used to take a lost own fix off the map). */
  drafts(nowSec: number, sourceRef?: string): ObservationDraft[] {
    const out: ObservationDraft[] = [];
    for (const num of this.nodes.keys()) {
      const d = this.draft(num, nowSec, sourceRef);
      if (d) out.push(d);
    }
    return out;
  }

  /**
   * The node as an observation draft, or undefined while it has no position. `nowSec` dates a
   * node whose position carries no time (or a time in the future) at its last hearing, or now.
   */
  draft(num: number, nowSec: number, sourceRef?: string): ObservationDraft | undefined {
    const s = this.nodes.get(num);
    if (!s || s.latitude === undefined || s.longitude === undefined) return undefined;
    // This computer's own node is drawn where its own GPS says, and only while it has a fix (or
    // an old fix, or a position set by hand) — with NO FIX it is not drawn at all.
    const own = num === this.myNodeNum ? evaluateOwnFix(s.report, nowSec) : undefined;
    if (own && (own.latitude === undefined || own.longitude === undefined)) return undefined;
    const id = nodeId(num);
    const payload: Record<string, JsonValue> = { sensorKind: 'meshtastic-node', nodeId: id };
    const u = s.user;
    const name = u?.longName?.trim() || u?.shortName?.trim();
    payload['name'] = (name || id).slice(0, 200);
    if (u?.shortName?.trim()) payload['shortName'] = u.shortName.trim().slice(0, 16);
    if (u?.hwModel !== undefined) payload['hardwareModel'] = u.hwModel;
    if (u?.role !== undefined) payload['role'] = u.role;
    // Written for every node, so a node that stops being this one (another board plugged in)
    // loses both: the world merges new properties over old ones.
    payload['thisNode'] = own !== undefined;
    payload['ownFix'] = own ? ownFixPayload(own) : null;
    const d = s.device;
    if (d?.batteryLevel !== undefined) {
      if (d.batteryLevel > 100) payload['externalPower'] = true;
      else payload['batteryPct'] = d.batteryLevel;
    }
    if (d?.voltage !== undefined && d.voltage > 0) payload['voltageV'] = round(d.voltage, 2);
    if (d?.channelUtilization !== undefined) payload['channelUtilizationPct'] = round(d.channelUtilization, 1);
    if (d?.airUtilTx !== undefined) payload['airUtilTxPct'] = round(d.airUtilTx, 1);
    if (d?.uptimeSeconds !== undefined) payload['uptimeSeconds'] = d.uptimeSeconds;
    const e = s.environment;
    if (e?.temperatureC !== undefined) payload['temperatureC'] = round(e.temperatureC, 1);
    if (e?.relativeHumidity !== undefined) payload['humidityPct'] = round(e.relativeHumidity, 1);
    if (e?.barometricPressureHpa !== undefined) payload['pressureHpa'] = round(e.barometricPressureHpa, 1);
    if (s.snr !== undefined) payload['snrDb'] = round(s.snr, 1);
    if (s.rssi !== undefined) payload['rssiDbm'] = s.rssi;
    if (s.hopsAway !== undefined) payload['hopsAway'] = s.hopsAway;
    if (s.viaMqtt) payload['viaMqtt'] = true;
    if (s.lastHeard) payload['lastHeardAt'] = new Date(s.lastHeard * 1000).toISOString();
    const accuracy = precisionMetres(s.precisionBits);
    if (accuracy !== undefined) payload['positionPrecisionM'] = accuracy;

    const flags: string[] = [];
    let observedSec = own ? own.fixSec : s.positionTime;
    if (own?.state === 'manual') flags.push('position-set-by-hand');
    if (!observedSec || observedSec > nowSec + 300) {
      observedSec = s.lastHeard && s.lastHeard <= nowSec + 300 ? s.lastHeard : nowSec;
      flags.push('time-from-receipt');
    }
    const positionAccuracy = own ? own.accuracyM : accuracy;
    const draft: ObservationDraft = {
      externalId: id,
      objectType: 'sensor',
      observedAt: new Date(observedSec * 1000).toISOString(),
      position: own
        ? {
            latitude: own.latitude!,
            longitude: own.longitude!,
            ...(own.altitudeM !== undefined ? { altitudeM: own.altitudeM } : {}),
          }
        : {
            latitude: s.latitude,
            longitude: s.longitude,
            ...(s.altitudeM !== undefined ? { altitudeM: s.altitudeM } : {}),
          },
      payload,
      quality: {
        complete: name !== undefined && name !== '',
        sourceQuality: own && own.state !== 'manual' ? 'authoritative' : 'crowdsourced',
        ...(positionAccuracy !== undefined ? { positionAccuracyM: positionAccuracy } : {}),
        ...(flags.length ? { flags } : {}),
      },
      origin: 'local',
    };
    if (sourceRef) draft.sourceRef = sourceRef;
    return draft;
  }
}

/**
 * What a node's own position report says about where this computer is. GPS only when the node
 * says its own (or an attached) GPS produced it, or — older firmware, no source given — when the
 * report carries a GPS timestamp. A fix type of 1 (no fix), 0/0, or no report at all is NO FIX.
 */
export function evaluateOwnFix(p: MeshPosition | undefined, nowSec: number): OwnFix {
  if (!p) return { state: 'no-fix', text: 'NO FIX (the node has not reported a position)' };
  const at = validPosition(p);
  if (!at || p.fixType === 1) return { state: 'no-fix', text: 'NO FIX' };
  const src = p.locationSource ?? LOC_UNSET;
  const coords = {
    latitude: at.latitude,
    longitude: at.longitude,
    ...(p.altitudeM !== undefined ? { altitudeM: p.altitudeM } : {}),
  };
  if (src === LOC_MANUAL) {
    const t = p.time || p.fixTime;
    return {
      state: 'manual',
      text: 'fixed position set on the node (not GPS)',
      source: 'set by hand',
      ...coords,
      ...(t ? { fixSec: t } : {}),
    };
  }
  const gnss = src === LOC_INTERNAL || src === LOC_EXTERNAL || (src === LOC_UNSET && !!p.fixTime);
  if (!gnss)
    return {
      state: 'not-gnss',
      text: 'NO FIX (the node reports a position that did not come from its GPS)',
    };
  const fixSec = p.fixTime || p.time;
  if (!fixSec) return { state: 'no-fix', text: 'NO FIX (a GPS position without a fix time)' };
  const clockAhead = fixSec > nowSec + 300;
  const ageSeconds = Math.max(0, nowSec - fixSec);
  const fixType = p.fixType === 3 ? '3D' : p.fixType === 2 ? '2D' : undefined;
  const hdop = p.hdop ? p.hdop / 100 : undefined;
  const dop = p.hdop || p.pdop;
  let accuracyM = p.gpsAccuracyMm && dop ? round((p.gpsAccuracyMm / 1000) * (dop / 100), 1) : undefined;
  const coarse = precisionMetres(p.precisionBits);
  if (coarse !== undefined) accuracyM = Math.max(accuracyM ?? 0, coarse);
  const state: OwnFixState = clockAhead ? 'unknown-age' : ageSeconds > OWN_FIX_FRESH_SECONDS ? 'stale' : 'fix';
  const detail = [fixType, p.satsInView ? `${p.satsInView} satellites` : undefined].filter(Boolean).join(', ');
  const text =
    (state === 'fix' ? 'GPS fix' : state === 'stale' ? 'STALE GPS fix' : 'GPS fix of unknown age') +
    (detail ? ` (${detail})` : '') +
    (clockAhead ? ", its time ahead of this computer's clock" : `, ${ageText(ageSeconds)} old`) +
    (accuracyM !== undefined ? `, ±${accuracyM} m` : '');
  return {
    state,
    text,
    source: src === LOC_INTERNAL ? 'own GPS' : src === LOC_EXTERNAL ? 'external GPS' : 'GPS',
    ...coords,
    fixSec,
    ...(clockAhead ? { clockAhead: true } : { ageSeconds }),
    ...(accuracyM !== undefined ? { accuracyM } : {}),
    ...(p.satsInView ? { satellites: p.satsInView } : {}),
    ...(fixType ? { fixType } : {}),
    ...(hdop !== undefined ? { hdop } : {}),
  };
}

export function ageText(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
}

/** Stored with the observation: no age or wording, which go out of date — the UI works them out from `fixAt`. */
function ownFixPayload(f: OwnFix): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { kind: f.state === 'manual' ? 'set-by-hand' : 'gps' };
  if (f.source) out['source'] = f.source;
  if (f.fixSec) out['fixAt'] = new Date(f.fixSec * 1000).toISOString();
  if (f.accuracyM !== undefined) out['accuracyM'] = f.accuracyM;
  if (f.satellites !== undefined) out['satellites'] = f.satellites;
  if (f.fixType) out['fixType'] = f.fixType;
  if (f.hdop !== undefined) out['hdop'] = f.hdop;
  if (f.clockAhead) out['clockAhead'] = true;
  return out;
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
