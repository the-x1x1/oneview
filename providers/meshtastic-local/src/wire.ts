/**
 * Meshtastic's client stream, read by hand: the frames a node sends over TCP (and serial) and
 * the protocol-buffer messages inside them, only as far as this provider needs them.
 *
 * Written from the wire format Meshtastic publishes (the "Client API" page and the field
 * numbers of its message definitions): no Meshtastic code or definition file is included —
 * those are GPL-3.0. Every field not listed here is skipped by its wire type, so a newer
 * firmware that adds fields still reads.
 */

/** A frame starts with these two bytes, then the payload length (big-endian, at most 512). */
export const START1 = 0x94;
export const START2 = 0xc3;
export const MAX_FRAME_PAYLOAD = 512;
/** The TCP port a node with Wi-Fi or Ethernet serves its client API on. */
export const DEFAULT_MESHTASTIC_PORT = 4403;

/** Meshtastic's application port numbers this provider reads (`Data.portnum`). */
export const PORT_TEXT_MESSAGE = 1;
export const PORT_POSITION = 3;
export const PORT_NODEINFO = 4;
export const PORT_TELEMETRY = 67;

// ── frames ─────────────────────────────────────────────────────────────────

/**
 * Splits the byte stream into frame payloads. Bytes before a frame start are skipped (a node
 * also prints its debug log on the same stream); a length over 512 means the start was not a
 * start, and the search resumes one byte later. A partial frame waits for the rest. The
 * buffer never holds more than one frame's worth.
 */
export class FrameReader {
  private buf = new Uint8Array(0);
  /** Bytes skipped looking for a frame (log text, noise, a frame cut short by a reconnect). */
  skipped = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf, 0);
    joined.set(chunk, this.buf.length);
    const out: Uint8Array[] = [];
    let i = 0;
    while (i < joined.length) {
      if (joined[i] !== START1) {
        i++;
        this.skipped++;
        continue;
      }
      if (i + 1 >= joined.length) break;
      if (joined[i + 1] !== START2) {
        i++;
        this.skipped++;
        continue;
      }
      if (i + 3 >= joined.length) break;
      const len = (joined[i + 2]! << 8) | joined[i + 3]!;
      if (len > MAX_FRAME_PAYLOAD) {
        i++;
        this.skipped++;
        continue;
      }
      if (i + 4 + len > joined.length) break;
      out.push(joined.slice(i + 4, i + 4 + len));
      i += 4 + len;
    }
    this.buf = joined.slice(i);
    return out;
  }
}

/** A payload in a frame, for writing to the node. */
export function frame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_PAYLOAD) throw new RangeError('frame payload over 512 bytes');
  const out = new Uint8Array(4 + payload.length);
  out[0] = START1;
  out[1] = START2;
  out[2] = payload.length >> 8;
  out[3] = payload.length & 0xff;
  out.set(payload, 4);
  return out;
}

// ── protocol buffers, the reading side ─────────────────────────────────────

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const FIXED32 = 5;

export class ProtoError extends Error {}

/** One message's fields in order, each read on demand by the caller that knows its type. */
export class ProtoReader {
  private pos = 0;
  private readonly view: DataView;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /** The next field's number and wire type, or undefined at the end. */
  next(): { field: number; wire: number } | undefined {
    if (this.pos >= this.buf.length) return undefined;
    const key = this.varint();
    const field = Math.floor(key.lo / 8) + key.hi * 0x20000000;
    const wire = key.lo & 7;
    if (field < 1) throw new ProtoError('field number 0');
    return { field, wire };
  }

  /** A varint's low and high 32 bits, so 64-bit values and negative int32s read exactly. */
  private varint(): { lo: number; hi: number } {
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new ProtoError('varint runs past the end');
      const b = this.buf[this.pos++]!;
      if (i < 4) lo |= (b & 0x7f) << (7 * i);
      else if (i === 4) {
        lo |= (b & 0x0f) << 28;
        hi |= (b & 0x7f) >> 4;
      } else hi |= (b & 0x7f) << (7 * i - 32);
      if ((b & 0x80) === 0) return { lo: lo >>> 0, hi: hi >>> 0 };
    }
    throw new ProtoError('varint longer than ten bytes');
  }

  private expect(wire: number, want: number): void {
    if (wire !== want) throw new ProtoError(`wire type ${wire} where ${want} was expected`);
  }

  uint32(wire: number): number {
    this.expect(wire, VARINT);
    return this.varint().lo;
  }
  /** An `int32`: negative values are sent sign-extended to ten bytes; the low 32 bits are the value. */
  int32(wire: number): number {
    this.expect(wire, VARINT);
    return this.varint().lo | 0;
  }
  /** A `sint32` (zigzag). */
  sint32(wire: number): number {
    const n = this.uint32(wire);
    return (n >>> 1) ^ -(n & 1);
  }
  bool(wire: number): boolean {
    this.expect(wire, VARINT);
    const v = this.varint();
    return v.lo !== 0 || v.hi !== 0;
  }
  fixed32(wire: number): number {
    this.expect(wire, FIXED32);
    if (this.pos + 4 > this.buf.length) throw new ProtoError('fixed32 runs past the end');
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  sfixed32(wire: number): number {
    return this.fixed32(wire) | 0;
  }
  float(wire: number): number {
    this.expect(wire, FIXED32);
    if (this.pos + 4 > this.buf.length) throw new ProtoError('float runs past the end');
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  bytes(wire: number): Uint8Array {
    this.expect(wire, LENGTH);
    const { lo, hi } = this.varint();
    if (hi !== 0 || this.pos + lo > this.buf.length) throw new ProtoError('length runs past the end');
    const out = this.buf.subarray(this.pos, this.pos + lo);
    this.pos += lo;
    return out;
  }
  string(wire: number): string {
    return new TextDecoder('utf-8').decode(this.bytes(wire));
  }
  /** Step over a field this reader does not use. */
  skip(wire: number): void {
    switch (wire) {
      case VARINT:
        this.varint();
        return;
      case FIXED64:
        if (this.pos + 8 > this.buf.length) throw new ProtoError('fixed64 runs past the end');
        this.pos += 8;
        return;
      case LENGTH:
        this.bytes(wire);
        return;
      case FIXED32:
        if (this.pos + 4 > this.buf.length) throw new ProtoError('fixed32 runs past the end');
        this.pos += 4;
        return;
      default:
        throw new ProtoError(`wire type ${wire} is not read`);
    }
  }
}

// ── the messages ───────────────────────────────────────────────────────────

export interface MeshPosition {
  /** 1e-7 degrees, as sent. */
  latitudeI?: number;
  longitudeI?: number;
  /** Metres above mean sea level. */
  altitudeM?: number;
  /** Seconds since 1970: the GPS fix (`timestamp`) where sent, else the node's clock (`time`). */
  fixTime?: number;
  time?: number;
  /** Bits of precision the sender kept (1–31 = deliberately coarsened; 0 or 32 = full). */
  precisionBits?: number;
  satsInView?: number;
  /** Where the sender's position came from: 0 unset, 1 set by hand, 2 its own GPS, 3 an external GPS. */
  locationSource?: number;
  /** Dilution of precision, in hundredths (PDOP, HDOP). */
  pdop?: number;
  hdop?: number;
  /** The GPS receiver's accuracy figure in millimetres (multiplied by a DOP for metres). */
  gpsAccuracyMm?: number;
  /** NMEA fix quality (0 invalid, 1 GPS, 2 DGPS …) and fix type (1 none, 2 2D, 3 3D). */
  fixQuality?: number;
  fixType?: number;
}

/** `Position.location_source` values. */
export const LOC_UNSET = 0;
export const LOC_MANUAL = 1;
export const LOC_INTERNAL = 2;
export const LOC_EXTERNAL = 3;

export interface MeshUser {
  id?: string;
  longName?: string;
  shortName?: string;
  hwModel?: number;
  role?: number;
  isLicensed?: boolean;
}

export interface MeshDeviceMetrics {
  /** 0–100; 101 means powered from outside. */
  batteryLevel?: number;
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  uptimeSeconds?: number;
}

export interface MeshEnvironment {
  temperatureC?: number;
  relativeHumidity?: number;
  barometricPressureHpa?: number;
}

export interface MeshTelemetry {
  time?: number;
  device?: MeshDeviceMetrics;
  environment?: MeshEnvironment;
}

export interface MeshNodeInfo {
  num: number;
  user?: MeshUser;
  position?: MeshPosition;
  snr?: number;
  lastHeard?: number;
  device?: MeshDeviceMetrics;
  hopsAway?: number;
  viaMqtt?: boolean;
}

export interface MeshPacket {
  from: number;
  to: number;
  rxTime?: number;
  rxSnr?: number;
  rxRssi?: number;
  hopStart?: number;
  hopLimit?: number;
  viaMqtt?: boolean;
  /** Only when the node could decrypt it. A text message's payload is never kept. */
  decoded?: { portnum: number; payload?: Uint8Array };
  /** The node could not decrypt it (a channel it does not have the key for). */
  encrypted?: boolean;
}

export type FromRadio =
  | { kind: 'packet'; packet: MeshPacket }
  | { kind: 'my-info'; myNodeNum: number }
  | { kind: 'node-info'; node: MeshNodeInfo }
  | { kind: 'config-complete'; id: number }
  | { kind: 'rebooted' }
  | { kind: 'other' };

export function readPosition(buf: Uint8Array): MeshPosition {
  const r = new ProtoReader(buf);
  const p: MeshPosition = {};
  for (let f = r.next(); f; f = r.next()) {
    switch (f.field) {
      case 1:
        p.latitudeI = r.sfixed32(f.wire);
        break;
      case 2:
        p.longitudeI = r.sfixed32(f.wire);
        break;
      case 3:
        p.altitudeM = r.int32(f.wire);
        break;
      case 4:
        p.time = r.fixed32(f.wire);
        break;
      case 5:
        p.locationSource = r.uint32(f.wire);
        break;
      case 7:
        p.fixTime = r.fixed32(f.wire);
        break;
      case 11:
        p.pdop = r.uint32(f.wire);
        break;
      case 12:
        p.hdop = r.uint32(f.wire);
        break;
      case 14:
        p.gpsAccuracyMm = r.uint32(f.wire);
        break;
      case 17:
        p.fixQuality = r.uint32(f.wire);
        break;
      case 18:
        p.fixType = r.uint32(f.wire);
        break;
      case 19:
        p.satsInView = r.uint32(f.wire);
        break;
      case 23:
        p.precisionBits = r.uint32(f.wire);
        break;
      default:
        r.skip(f.wire);
    }
  }
  return p;
}

export function readUser(buf: Uint8Array): MeshUser {
  const r = new ProtoReader(buf);
  const u: MeshUser = {};
  for (let f = r.next(); f; f = r.next()) {
    switch (f.field) {
      case 1:
        u.id = r.string(f.wire);
        break;
      case 2:
        u.longName = r.string(f.wire);
        break;
      case 3:
        u.shortName = r.string(f.wire);
        break;
      case 5:
        u.hwModel = r.uint32(f.wire);
        break;
      case 6:
        u.isLicensed = r.bool(f.wire);
        break;
      case 7:
        u.role = r.uint32(f.wire);
        break;
      default:
        r.skip(f.wire);
    }
  }
  return u;
}

export function readDeviceMetrics(buf: Uint8Array): MeshDeviceMetrics {
  const r = new ProtoReader(buf);
  const d: MeshDeviceMetrics = {};
  for (let f = r.next(); f; f = r.next()) {
    switch (f.field) {
      case 1:
        d.batteryLevel = r.uint32(f.wire);
        break;
      case 2:
        d.voltage = r.float(f.wire);
        break;
      case 3:
        d.channelUtilization = r.float(f.wire);
        break;
      case 4:
        d.airUtilTx = r.float(f.wire);
        break;
      case 5:
        d.uptimeSeconds = r.uint32(f.wire);
        break;
      default:
        r.skip(f.wire);
    }
  }
  return d;
}

export function readEnvironment(buf: Uint8Array): MeshEnvironment {
  const r = new ProtoReader(buf);
  const e: MeshEnvironment = {};
  for (let f = r.next(); f; f = r.next()) {
    switch (f.field) {
      case 1:
        e.temperatureC = r.float(f.wire);
        break;
      case 2:
        e.relativeHumidity = r.float(f.wire);
        break;
      case 3:
        e.barometricPressureHpa = r.float(f.wire);
        break;
      default:
        r.skip(f.wire);
    }
  }
  return e;
}

export function readTelemetry(buf: Uint8Array): MeshTelemetry {
  const r = new ProtoReader(buf);
  const t: MeshTelemetry = {};
  for (let f = r.next(); f; f = r.next()) {
    switch (f.field) {
      case 1:
        t.time = r.fixed32(f.wire);
        break;
      case 2:
        t.device = readDeviceMetrics(r.bytes(f.wire));
        break;
      case 3:
        t.environment = readEnvironment(r.bytes(f.wire));
        break;
      default:
        r.skip(f.wire);
    }
  }
  return t;
}

export function readNodeInfo(buf: Uint8Array): MeshNodeInfo {
  const r = new ProtoReader(buf);
  const n: MeshNodeInfo = { num: 0 };
  for (let f = r.next(); f; f = r.next()) {
    switch (f.field) {
      case 1:
        n.num = r.uint32(f.wire);
        break;
      case 2:
        n.user = readUser(r.bytes(f.wire));
        break;
      case 3:
        n.position = readPosition(r.bytes(f.wire));
        break;
      case 4:
        n.snr = r.float(f.wire);
        break;
      case 5:
        n.lastHeard = r.fixed32(f.wire);
        break;
      case 6:
        n.device = readDeviceMetrics(r.bytes(f.wire));
        break;
      case 8:
        n.viaMqtt = r.bool(f.wire);
        break;
      case 9:
        n.hopsAway = r.uint32(f.wire);
        break;
      default:
        r.skip(f.wire);
    }
  }
  return n;
}

function readData(buf: Uint8Array): { portnum: number; payload?: Uint8Array } {
  const r = new ProtoReader(buf);
  let portnum = 0;
  let payload: Uint8Array | undefined;
  for (let f = r.next(); f; f = r.next()) {
    if (f.field === 1) portnum = r.uint32(f.wire);
    else if (f.field === 2) payload = r.bytes(f.wire);
    else r.skip(f.wire);
  }
  // What people send each other is not kept, not even as bytes.
  if (portnum === PORT_TEXT_MESSAGE) return { portnum };
  return payload ? { portnum, payload } : { portnum };
}

export function readMeshPacket(buf: Uint8Array): MeshPacket {
  const r = new ProtoReader(buf);
  const p: MeshPacket = { from: 0, to: 0 };
  for (let f = r.next(); f; f = r.next()) {
    switch (f.field) {
      case 1:
        p.from = r.fixed32(f.wire);
        break;
      case 2:
        p.to = r.fixed32(f.wire);
        break;
      case 4:
        p.decoded = readData(r.bytes(f.wire));
        break;
      case 5:
        r.skip(f.wire);
        p.encrypted = true;
        break;
      case 7:
        p.rxTime = r.fixed32(f.wire);
        break;
      case 8:
        p.rxSnr = r.float(f.wire);
        break;
      case 9:
        p.hopLimit = r.uint32(f.wire);
        break;
      case 12:
        p.rxRssi = r.int32(f.wire);
        break;
      case 14:
        p.viaMqtt = r.bool(f.wire);
        break;
      case 15:
        p.hopStart = r.uint32(f.wire);
        break;
      default:
        r.skip(f.wire);
    }
  }
  return p;
}

/** One frame from the node. Throws ProtoError on a payload that is not a `FromRadio`. */
export function readFromRadio(buf: Uint8Array): FromRadio {
  const r = new ProtoReader(buf);
  let out: FromRadio = { kind: 'other' };
  for (let f = r.next(); f; f = r.next()) {
    switch (f.field) {
      case 2:
        out = { kind: 'packet', packet: readMeshPacket(r.bytes(f.wire)) };
        break;
      case 3: {
        const my = new ProtoReader(r.bytes(f.wire));
        let myNodeNum = 0;
        for (let g = my.next(); g; g = my.next()) {
          if (g.field === 1) myNodeNum = my.uint32(g.wire);
          else my.skip(g.wire);
        }
        out = { kind: 'my-info', myNodeNum };
        break;
      }
      case 4:
        out = { kind: 'node-info', node: readNodeInfo(r.bytes(f.wire)) };
        break;
      case 7:
        out = { kind: 'config-complete', id: r.uint32(f.wire) };
        break;
      case 8:
        r.skip(f.wire);
        out = { kind: 'rebooted' };
        break;
      default:
        r.skip(f.wire);
    }
  }
  return out;
}

// ── what the provider sends ────────────────────────────────────────────────

function varintBytes(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

/**
 * `ToRadio { want_config_id }`, framed: asks the node for its own number and its node list,
 * after which it streams what it hears. The id comes back in `config_complete_id`.
 */
export function wantConfigFrame(id: number): Uint8Array {
  return frame(Uint8Array.from([(3 << 3) | VARINT, ...varintBytes(id)]));
}

/** `ToRadio { heartbeat {} }`, framed: keeps a quiet connection from being dropped by the node. */
export function heartbeatFrame(): Uint8Array {
  return frame(Uint8Array.from([(7 << 3) | LENGTH, 0]));
}

/** The node id as Meshtastic writes it: `!` and eight hex digits. */
export function nodeId(num: number): string {
  return `!${(num >>> 0).toString(16).padStart(8, '0')}`;
}
