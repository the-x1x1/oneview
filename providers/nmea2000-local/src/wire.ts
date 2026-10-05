/**
 * NMEA 2000 as a gateway passes it on in Yacht Devices' RAW text format — one CAN frame a
 * line, `17:33:21.107 R 09F80103 2F 30 70 00 2F 30 70 00`: the gateway's time of day, R
 * (received from the bus) or T (sent to it), the 29-bit CAN identifier in hex, then up to
 * eight data bytes (Yacht Devices' user manuals give the format). Their Wi-Fi and Ethernet
 * gateways (YDWG-02, YDEN-02) serve it over TCP, and so do other gateways and multiplexers
 * that offer "YD RAW".
 *
 * Messages longer than a frame (an AIS report, a GNSS fix) come in NMEA 2000's fast-packet
 * form and are put back together here. The field layouts follow the open, reverse-engineered
 * descriptions of the CANboat project (github.com/canboat/canboat, Apache-2.0) — field
 * positions and resolutions only; none of its code is used. The decoder was checked against
 * CANboat's own analyzer, run outside this repository (wire.test.ts says how).
 */

export const DEFAULT_YD_RAW_PORT = 1457;

export interface CanFrame {
  /** 0 (highest) to 7. */
  priority: number;
  pgn: number;
  /** The sending device's address on the bus (0–253). */
  source: number;
  /** 255: every device. */
  destination: number;
  data: Uint8Array;
}

/** The parts of a 29-bit NMEA 2000 / ISO 11783 CAN identifier. */
export function canIdParts(id: number): Omit<CanFrame, 'data'> {
  const priority = (id >>> 26) & 0x7;
  const dataPage = (id >>> 24) & 0x3;
  const pduFormat = (id >>> 16) & 0xff;
  const pduSpecific = (id >>> 8) & 0xff;
  const source = id & 0xff;
  // PDU1 (format below 240): the specific byte is the destination, not part of the PGN.
  if (pduFormat < 240) return { priority, pgn: (dataPage << 16) | (pduFormat << 8), source, destination: pduSpecific };
  return { priority, pgn: (dataPage << 16) | (pduFormat << 8) | pduSpecific, source, destination: 255 };
}

const RAW_LINE = /^\d{2}:\d{2}:\d{2}\.\d{3} ([RT]) ([0-9A-Fa-f]{8})((?: [0-9A-Fa-f]{2}){1,8})\s*$/;

/**
 * One YD RAW line as a CAN frame, or undefined for anything else (a different format, a
 * truncated line, a frame this computer sent — T — which carries nothing heard).
 */
export function parseYdRawLine(line: string): CanFrame | undefined {
  const m = RAW_LINE.exec(line.trim());
  if (!m || m[1] !== 'R') return undefined;
  const id = parseInt(m[2]!, 16);
  if (id > 0x1fffffff) return undefined;
  const data = Uint8Array.from(
    m[3]!
      .trim()
      .split(' ')
      .map((h) => parseInt(h, 16)),
  );
  return { ...canIdParts(id), data };
}

/** The PGNs this provider reads that come as fast packets. */
export const FAST_PACKET_PGNS: ReadonlySet<number> = new Set([129029, 129038, 129039, 129794, 129809, 129810]);
/** A fast packet carries at most 223 bytes (6 + 31 × 7). */
const FAST_MAX = 223;

interface Partial {
  sequence: number;
  length: number;
  next: number;
  bytes: Uint8Array;
  filled: number;
  at: number;
}

/**
 * Puts fast packets back together, per sending device and PGN. A frame out of order, a new
 * sequence before the last was finished, or a gap of more than `maxGapMs` drops what was
 * collected — a broken message is never decoded.
 */
export class FastPacketAssembler {
  private readonly partial = new Map<string, Partial>();

  constructor(private readonly maxGapMs = 750) {}

  /** The whole message when this frame completes one; undefined while one is being collected. */
  push(frame: CanFrame, nowMs: number): Uint8Array | undefined {
    const d = frame.data;
    if (d.length < 2) return undefined;
    const key = `${frame.source}:${frame.pgn}`;
    const sequence = d[0]! >> 5;
    const index = d[0]! & 0x1f;
    if (index === 0) {
      const length = d[1]!;
      if (length === 0 || length > FAST_MAX) {
        this.partial.delete(key);
        return undefined;
      }
      const bytes = new Uint8Array(length);
      const take = Math.min(6, length, d.length - 2);
      bytes.set(d.subarray(2, 2 + take), 0);
      if (take >= length) {
        this.partial.delete(key);
        return bytes;
      }
      this.partial.set(key, { sequence, length, next: 1, bytes, filled: take, at: nowMs });
      return undefined;
    }
    const p = this.partial.get(key);
    if (!p || p.sequence !== sequence || p.next !== index || nowMs - p.at > this.maxGapMs) {
      this.partial.delete(key);
      return undefined;
    }
    const take = Math.min(7, p.length - p.filled, d.length - 1);
    p.bytes.set(d.subarray(1, 1 + take), p.filled);
    p.filled += take;
    p.next++;
    p.at = nowMs;
    if (p.filled < p.length) return undefined;
    this.partial.delete(key);
    return p.bytes;
  }

  /** How many messages are half collected (for tests and diagnostics). */
  get pending(): number {
    return this.partial.size;
  }
}

/**
 * How many codes at the top of a field's range are not data — "not available", "out of range"
 * and "reserved": three for a field of a byte or more, two from four bits, one from two
 * (S. Cassidy, "NMEA 2000 Explained"; uint16 data runs 0–65,532).
 */
function reservedCodes(bits: number): number {
  return bits >= 8 ? 3 : bits >= 4 ? 2 : bits >= 2 ? 1 : 0;
}

/**
 * Reads little-endian bit fields as NMEA 2000 packs them. A field holding one of its top codes
 * (`reservedCodes`) is not available: undefined.
 */
export class FieldReader {
  constructor(private readonly bytes: Uint8Array) {}

  get bitLength(): number {
    return this.bytes.length * 8;
  }

  /** The raw unsigned value of `length` bits at bit `offset` (up to 53 bits), or undefined past the end. */
  raw(offset: number, length: number): number | undefined {
    if (offset + length > this.bitLength || length > 53) return undefined;
    let value = 0;
    let scale = 1;
    let bit = offset;
    let left = length;
    while (left > 0) {
      const byte = this.bytes[bit >> 3]!;
      const shift = bit & 7;
      const take = Math.min(8 - shift, left);
      value += ((byte >> shift) & ((1 << take) - 1)) * scale;
      scale *= 2 ** take;
      bit += take;
      left -= take;
    }
    return value;
  }

  /** An unsigned number; the top codes (not available, out of range, reserved) are undefined. */
  unsigned(offset: number, length: number, resolution = 1): number | undefined {
    const v = this.raw(offset, length);
    if (v === undefined) return undefined;
    if (v > 2 ** length - 1 - reservedCodes(length)) return undefined;
    return v * resolution;
  }

  /** A two's-complement number; the top positive codes are undefined. */
  signed(offset: number, length: number, resolution = 1): number | undefined {
    const v = this.raw(offset, length);
    if (v === undefined) return undefined;
    const half = 2 ** (length - 1);
    if (v < half && v > half - 1 - reservedCodes(length)) return undefined;
    return (v >= half ? v - 2 ** length : v) * resolution;
  }

  /** A 64-bit two's-complement number (GNSS latitude and longitude), as a float. */
  signed64(offset: number, resolution: number): number | undefined {
    if (offset % 8 !== 0 || offset + 64 > this.bitLength) return undefined;
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset / 8, 8);
    const v = view.getBigInt64(0, true);
    if (v > 0x7ffffffffffffffcn) return undefined;
    return Number(v) * resolution;
  }

  /** Fixed-length text, padded with `@`, spaces, NUL or 0xFF; undefined when empty. */
  text(offset: number, bytes: number): string | undefined {
    if (offset % 8 !== 0 || offset / 8 + bytes > this.bytes.length) return undefined;
    let out = '';
    for (const b of this.bytes.subarray(offset / 8, offset / 8 + bytes)) {
      if (b === 0 || b === 0xff) break;
      out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
    }
    const t = out.replace(/[@ ]+$/, '').trim();
    return t || undefined;
  }
}
