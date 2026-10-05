/**
 * A protocol-buffer writer for tests only: builds the frames a Meshtastic node would send, by
 * field number, so the reader is tested against bytes laid out as the published wire format
 * says. Every fixture built with it is invented (node numbers, names, places, readings).
 */
import { frame } from '../src/wire.js';

type Part = number[];

function varint(n: number | bigint): Part {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: number[] = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

const key = (field: number, wire: number): Part => varint((field << 3) | wire);

export const pb = {
  /** uint32 / int32 / bool / enum (negative int32 is sign-extended to ten bytes, as protobuf does). */
  varint: (field: number, n: number | boolean): Part => [
    ...key(field, 0),
    ...varint(typeof n === 'boolean' ? (n ? 1 : 0) : n),
  ],
  sint32: (field: number, n: number): Part => [...key(field, 0), ...varint(((n << 1) ^ (n >> 31)) >>> 0)],
  fixed32: (field: number, n: number): Part => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return [...key(field, 5), ...b];
  },
  sfixed32: (field: number, n: number): Part => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n, true);
    return [...key(field, 5), ...b];
  },
  float: (field: number, n: number): Part => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, n, true);
    return [...key(field, 5), ...b];
  },
  fixed64: (field: number): Part => [...key(field, 1), 1, 2, 3, 4, 5, 6, 7, 8],
  bytes: (field: number, body: Part | Uint8Array): Part => [...key(field, 2), ...varint(body.length), ...body],
  string: (field: number, s: string): Part => pb.bytes(field, [...new TextEncoder().encode(s)]),
  msg: (...parts: Part[]): Part => parts.flat(),
};

export interface PositionFields {
  lat: number;
  lon: number;
  alt?: number;
  time?: number;
  fixTime?: number;
  precisionBits?: number;
}

export function position(p: PositionFields): Part {
  return pb.msg(
    pb.sfixed32(1, Math.round(p.lat * 1e7)),
    pb.sfixed32(2, Math.round(p.lon * 1e7)),
    p.alt !== undefined ? pb.varint(3, p.alt) : [],
    p.time !== undefined ? pb.fixed32(4, p.time) : [],
    p.fixTime !== undefined ? pb.fixed32(7, p.fixTime) : [],
    p.precisionBits !== undefined ? pb.varint(23, p.precisionBits) : [],
  );
}

export function user(u: { id?: string; longName?: string; shortName?: string; hwModel?: number }): Part {
  return pb.msg(
    u.id !== undefined ? pb.string(1, u.id) : [],
    u.longName !== undefined ? pb.string(2, u.longName) : [],
    u.shortName !== undefined ? pb.string(3, u.shortName) : [],
    pb.bytes(4, [0xde, 0xad, 0xbe, 0xef, 0, 1]), // the deprecated MAC address field: skipped
    u.hwModel !== undefined ? pb.varint(5, u.hwModel) : [],
  );
}

export function deviceMetrics(d: {
  battery?: number;
  voltage?: number;
  chUtil?: number;
  airTx?: number;
  uptime?: number;
}): Part {
  return pb.msg(
    d.battery !== undefined ? pb.varint(1, d.battery) : [],
    d.voltage !== undefined ? pb.float(2, d.voltage) : [],
    d.chUtil !== undefined ? pb.float(3, d.chUtil) : [],
    d.airTx !== undefined ? pb.float(4, d.airTx) : [],
    d.uptime !== undefined ? pb.varint(5, d.uptime) : [],
  );
}

export function nodeInfo(n: {
  num: number;
  user?: Part;
  position?: Part;
  snr?: number;
  lastHeard?: number;
  device?: Part;
  hopsAway?: number;
}): Part {
  return pb.msg(
    pb.varint(1, n.num),
    n.user ? pb.bytes(2, n.user) : [],
    n.position ? pb.bytes(3, n.position) : [],
    n.snr !== undefined ? pb.float(4, n.snr) : [],
    n.lastHeard !== undefined ? pb.fixed32(5, n.lastHeard) : [],
    n.device ? pb.bytes(6, n.device) : [],
    n.hopsAway !== undefined ? pb.varint(9, n.hopsAway) : [],
  );
}

export function packet(p: {
  from: number;
  to?: number;
  portnum?: number;
  payload?: Part;
  encrypted?: boolean;
  rxTime?: number;
  snr?: number;
  rssi?: number;
  hopStart?: number;
  hopLimit?: number;
}): Part {
  return pb.msg(
    pb.fixed32(1, p.from),
    pb.fixed32(2, p.to ?? 0xffffffff),
    pb.varint(3, 0),
    p.encrypted
      ? pb.bytes(5, [1, 2, 3, 4, 5, 6, 7, 8])
      : pb.bytes(4, pb.msg(pb.varint(1, p.portnum ?? 0), p.payload ? pb.bytes(2, p.payload) : [])),
    pb.fixed32(6, 0x12345678),
    p.rxTime !== undefined ? pb.fixed32(7, p.rxTime) : [],
    p.snr !== undefined ? pb.float(8, p.snr) : [],
    p.hopLimit !== undefined ? pb.varint(9, p.hopLimit) : [],
    p.rssi !== undefined ? pb.varint(12, p.rssi) : [],
    p.hopStart !== undefined ? pb.varint(15, p.hopStart) : [],
  );
}

/** `FromRadio` frames: the envelope around each kind the node sends. */
export const fromRadio = {
  myInfo: (num: number): Uint8Array => frame(Uint8Array.from(pb.msg(pb.varint(1, 1), pb.bytes(3, pb.varint(1, num))))),
  nodeInfo: (n: Part): Uint8Array => frame(Uint8Array.from(pb.msg(pb.varint(1, 2), pb.bytes(4, n)))),
  packet: (p: Part): Uint8Array => frame(Uint8Array.from(pb.msg(pb.varint(1, 3), pb.bytes(2, p)))),
  configComplete: (id: number): Uint8Array => frame(Uint8Array.from(pb.msg(pb.varint(1, 4), pb.varint(7, id)))),
  /** A config message (field 5) this provider does not read: skipped whole. */
  config: (): Uint8Array =>
    frame(Uint8Array.from(pb.msg(pb.varint(1, 5), pb.bytes(5, pb.msg(pb.fixed64(1), pb.varint(2, 3)))))),
  rebooted: (): Uint8Array => frame(Uint8Array.from(pb.varint(8, true))),
};

export function telemetry(t: { time?: number; device?: Part; environment?: Part }): Part {
  return pb.msg(
    t.time !== undefined ? pb.fixed32(1, t.time) : [],
    t.device ? pb.bytes(2, t.device) : [],
    t.environment ? pb.bytes(3, t.environment) : [],
  );
}

export function environment(e: { temperature?: number; humidity?: number; pressure?: number }): Part {
  return pb.msg(
    e.temperature !== undefined ? pb.float(1, e.temperature) : [],
    e.humidity !== undefined ? pb.float(2, e.humidity) : [],
    e.pressure !== undefined ? pb.float(3, e.pressure) : [],
  );
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
