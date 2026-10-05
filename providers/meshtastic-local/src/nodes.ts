import type { JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import {
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

  /** Nodes with a position, the ones the map can show. */
  get placed(): number {
    let n = 0;
    for (const s of this.nodes.values()) if (s.latitude !== undefined) n++;
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
    if (d.portnum === PORT_POSITION) this.setPosition(s, readPosition(d.payload));
    else if (d.portnum === PORT_NODEINFO) s.user = readUser(d.payload);
    else {
      const t = readTelemetry(d.payload);
      if (t.device) s.device = { ...s.device, ...t.device };
      if (t.environment) s.environment = { ...s.environment, ...t.environment };
    }
    return p.from;
  }

  /**
   * The node as an observation draft, or undefined while it has no position. `nowSec` dates a
   * node whose position carries no time (or a time in the future) at its last hearing, or now.
   */
  draft(num: number, nowSec: number, sourceRef?: string): ObservationDraft | undefined {
    const s = this.nodes.get(num);
    if (!s || s.latitude === undefined || s.longitude === undefined) return undefined;
    const id = nodeId(num);
    const payload: Record<string, JsonValue> = { sensorKind: 'meshtastic-node', nodeId: id };
    const u = s.user;
    const name = u?.longName?.trim() || u?.shortName?.trim();
    payload['name'] = (name || id).slice(0, 200);
    if (u?.shortName?.trim()) payload['shortName'] = u.shortName.trim().slice(0, 16);
    if (u?.hwModel !== undefined) payload['hardwareModel'] = u.hwModel;
    if (u?.role !== undefined) payload['role'] = u.role;
    if (num === this.myNodeNum) payload['thisNode'] = true;
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
    let observedSec = s.positionTime;
    if (!observedSec || observedSec > nowSec + 300) {
      observedSec = s.lastHeard && s.lastHeard <= nowSec + 300 ? s.lastHeard : nowSec;
      flags.push('time-from-receipt');
    }
    const draft: ObservationDraft = {
      externalId: id,
      objectType: 'sensor',
      observedAt: new Date(observedSec * 1000).toISOString(),
      position: {
        latitude: s.latitude,
        longitude: s.longitude,
        ...(s.altitudeM !== undefined ? { altitudeM: s.altitudeM } : {}),
      },
      payload,
      quality: {
        complete: name !== undefined && name !== '',
        sourceQuality: 'crowdsourced',
        ...(accuracy !== undefined ? { positionAccuracyM: accuracy } : {}),
        ...(flags.length ? { flags } : {}),
      },
      origin: 'local',
    };
    if (sourceRef) draft.sourceRef = sourceRef;
    return draft;
  }
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
