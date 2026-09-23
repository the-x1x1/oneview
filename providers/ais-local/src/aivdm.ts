/**
 * AIVDM/AIVDO — AIS messages as NMEA 0183 sentences (ITU-R M.1371, IEC 61162), the form every
 * AIS receiver speaks: `!AIVDM,<count>,<number>,<sequence id>,<channel>,<payload>,<fill bits>*<checksum>`.
 *
 * The payload is six-bit "armoured" ASCII: each character is 48 subtracted (and 8 more past 40),
 * six bits MSB first; `fill bits` are padding at the end of the last fragment. A message longer
 * than one sentence (type 5) comes in fragments sharing a sequence id, assembled here. Decoded:
 *
 *   1, 2, 3   Class A position report            18  Class B position report
 *   5         Class A static and voyage data     19  Class B extended position report
 *   24        Class B static data (part A: name; part B: type, call sign, dimensions)
 *
 * Field layouts follow the standard as documented by gpsd ("AIVDM/AIVDO protocol decoding",
 * https://gpsd.gitlab.io/gpsd/AIVDM.html); "not available" sentinels are returned as undefined.
 */
export type AisMessage =
  | {
      type: 1 | 2 | 3 | 18 | 19;
      mmsi: number;
      navStatus?: number;
      rateOfTurn?: number;
      speedKnots?: number;
      accuracy: boolean;
      longitude?: number;
      latitude?: number;
      courseDeg?: number;
      headingDeg?: number;
      second?: number;
      /** Type 19 carries the static fields too. */
      shipName?: string;
      shipType?: number;
      dimensions?: Dimensions;
    }
  | {
      type: 5;
      mmsi: number;
      imo?: number;
      callSign?: string;
      shipName?: string;
      shipType?: number;
      dimensions?: Dimensions;
      eta?: { month: number; day: number; hour: number; minute: number };
      draughtM?: number;
      destination?: string;
    }
  | { type: 24; mmsi: number; part: 'A'; shipName?: string }
  | { type: 24; mmsi: number; part: 'B'; shipType?: number; callSign?: string; dimensions?: Dimensions };

export interface Dimensions {
  toBow: number;
  toStern: number;
  toPort: number;
  toStarboard: number;
}

export type SentenceResult =
  | { kind: 'message'; message: AisMessage; channel?: string; own: boolean }
  | { kind: 'fragment' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'invalid'; reason: string };

/** XOR of every character between the start delimiter and '*'. */
export function nmeaChecksum(body: string): number {
  let x = 0;
  for (let i = 0; i < body.length; i++) x ^= body.charCodeAt(i);
  return x;
}

/** Six-bit armoured payload → bits (one number 0/1 per element), fill bits removed. */
export function payloadBits(payload: string, fillBits: number): Uint8Array | undefined {
  const bits = new Uint8Array(payload.length * 6);
  for (let i = 0; i < payload.length; i++) {
    let v = payload.charCodeAt(i) - 48;
    if (v > 40) v -= 8;
    if (v < 0 || v > 63) return undefined;
    for (let b = 0; b < 6; b++) bits[i * 6 + b] = (v >> (5 - b)) & 1;
  }
  if (fillBits < 0 || fillBits > 5 || fillBits > bits.length) return undefined;
  return bits.subarray(0, bits.length - fillBits);
}

function uint(bits: Uint8Array, start: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 2 + (bits[start + i] ?? 0);
  return v;
}

function int(bits: Uint8Array, start: number, len: number): number {
  const v = uint(bits, start, len);
  return bits[start] ? v - 2 ** len : v;
}

/** Six-bit text: 0–31 are '@'–'_', 32–63 are ' '–'?'; '@' is padding. */
function text(bits: Uint8Array, start: number, chars: number): string | undefined {
  let s = '';
  for (let i = 0; i < chars; i++) {
    if (start + (i + 1) * 6 > bits.length) break;
    const v = uint(bits, start + i * 6, 6);
    s += String.fromCharCode(v < 32 ? v + 64 : v);
  }
  const t = s.replace(/@.*$/, '').trim();
  return t || undefined;
}

function dims(bits: Uint8Array, start: number): Dimensions | undefined {
  const d = {
    toBow: uint(bits, start, 9),
    toStern: uint(bits, start + 9, 9),
    toPort: uint(bits, start + 18, 6),
    toStarboard: uint(bits, start + 24, 6),
  };
  return d.toBow + d.toStern + d.toPort + d.toStarboard > 0 ? d : undefined;
}

/** Longitude/latitude in 1/10 000 minute, with 181° / 91° meaning "not available". */
function position(bits: Uint8Array, lonAt: number, latAt: number): { longitude?: number; latitude?: number } {
  const lon = int(bits, lonAt, 28) / 600_000;
  const lat = int(bits, latAt, 27) / 600_000;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return {};
  return { longitude: Math.round(lon * 1e6) / 1e6, latitude: Math.round(lat * 1e6) / 1e6 };
}

function motion(bits: Uint8Array, speedAt: number, courseAt: number, headingAt: number, secondAt: number) {
  const out: { speedKnots?: number; courseDeg?: number; headingDeg?: number; second?: number } = {};
  const speed = uint(bits, speedAt, 10);
  if (speed !== 1023) out.speedKnots = speed / 10;
  const course = uint(bits, courseAt, 12);
  if (course < 3600) out.courseDeg = course / 10;
  const heading = uint(bits, headingAt, 9);
  if (heading < 360) out.headingDeg = heading;
  const second = uint(bits, secondAt, 6);
  if (second < 60) out.second = second;
  return out;
}

export function decodeMessage(bits: Uint8Array): AisMessage | string {
  if (bits.length < 38) return 'payload too short';
  const type = uint(bits, 0, 6);
  const mmsi = uint(bits, 8, 30);
  switch (type) {
    case 1:
    case 2:
    case 3: {
      if (bits.length < 149) return `type ${type} too short`;
      const turn = int(bits, 42, 8);
      const status = uint(bits, 38, 4);
      return {
        type,
        mmsi,
        ...(status !== 15 ? { navStatus: status } : {}),
        ...(turn !== -128 ? { rateOfTurn: turn } : {}),
        accuracy: bits[60] === 1,
        ...position(bits, 61, 89),
        ...motion(bits, 50, 116, 128, 137),
      };
    }
    case 18:
    case 19: {
      if (bits.length < (type === 18 ? 148 : 301)) return `type ${type} too short`;
      const base = {
        type,
        mmsi,
        accuracy: bits[56] === 1,
        ...position(bits, 57, 85),
        ...motion(bits, 46, 112, 124, 133),
      } as const;
      if (type === 18) return base;
      const shipType = uint(bits, 263, 8);
      const shipName = text(bits, 143, 20);
      const d = dims(bits, 271);
      return {
        ...base,
        ...(shipName ? { shipName } : {}),
        ...(shipType ? { shipType } : {}),
        ...(d ? { dimensions: d } : {}),
      };
    }
    case 5: {
      if (bits.length < 420) return 'type 5 too short';
      const imo = uint(bits, 40, 30);
      const callSign = text(bits, 70, 7);
      const shipName = text(bits, 112, 20);
      const shipType = uint(bits, 232, 8);
      const d = dims(bits, 240);
      const month = uint(bits, 274, 4);
      const day = uint(bits, 278, 5);
      const hour = uint(bits, 283, 5);
      const minute = uint(bits, 288, 6);
      const draught = uint(bits, 294, 8);
      const destination = text(bits, 302, 20);
      return {
        type: 5,
        mmsi,
        ...(imo ? { imo } : {}),
        ...(callSign ? { callSign } : {}),
        ...(shipName ? { shipName } : {}),
        ...(shipType ? { shipType } : {}),
        ...(d ? { dimensions: d } : {}),
        ...(month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour < 24 && minute < 60
          ? { eta: { month, day, hour, minute } }
          : {}),
        ...(draught ? { draughtM: draught / 10 } : {}),
        ...(destination ? { destination } : {}),
      };
    }
    case 24: {
      if (bits.length < 40) return 'type 24 too short';
      const part = uint(bits, 38, 2);
      if (part === 0) {
        const shipName = text(bits, 40, 20);
        return { type: 24, mmsi, part: 'A', ...(shipName ? { shipName } : {}) };
      }
      if (part === 1) {
        if (bits.length < 162) return 'type 24 part B too short';
        const shipType = uint(bits, 40, 8);
        const callSign = text(bits, 90, 7);
        // An auxiliary craft (MMSI 98xxxyyyy) carries its mothership's MMSI where the dimensions are.
        const auxiliary = Math.floor(mmsi / 10_000_000) === 98;
        const d = auxiliary ? undefined : dims(bits, 132);
        return {
          type: 24,
          mmsi,
          part: 'B',
          ...(shipType ? { shipType } : {}),
          ...(callSign ? { callSign } : {}),
          ...(d ? { dimensions: d } : {}),
        };
      }
      return 'type 24 with an unknown part number';
    }
    default:
      return `type ${type} not decoded`;
  }
}

const SENTENCE =
  /^[!$](AI|BS|AB|SA)(VDM|VDO),(\d),(\d),(\d?),([ABab12]?),([0-9:;<=>?@A-W`a-w]*),([0-5])\*([0-9A-Fa-f]{2})$/;
const FRAGMENT_TTL_MS = 10_000;
const MAX_PENDING = 64;

/**
 * Sentences in, messages out. Holds the fragments of multi-sentence messages (by sequence id and
 * channel) for up to ten seconds; a fragment out of order, or an assembly that times out, is
 * dropped. A line with any other talker or sentence (GPS `$GPRMC`, `$GPGGA`, …) is ignored, as
 * is one with a tag block prefix it cannot read.
 */
export class AivdmAssembler {
  private readonly pending = new Map<string, { parts: string[]; fill: number; at: number; count: number }>();

  push(line: string, nowMs: number): SentenceResult {
    const raw = line.trim().replace(/^\\[^\\]*\\/, ''); // an NMEA 4.0 tag block, if any
    if (!raw) return { kind: 'ignored', reason: 'empty line' };
    const star = raw.lastIndexOf('*');
    if (raw[0] !== '!' && raw[0] !== '$') return { kind: 'ignored', reason: 'not an NMEA sentence' };
    const m = SENTENCE.exec(raw);
    if (!m) {
      if (/^[!$][A-Z]{2}VD[MO],/.test(raw)) return { kind: 'invalid', reason: 'malformed AIVDM sentence' };
      return { kind: 'ignored', reason: 'not an AIS sentence' };
    }
    if (star < 1 || nmeaChecksum(raw.slice(1, star)) !== parseInt(m[9]!, 16))
      return { kind: 'invalid', reason: 'checksum mismatch' };
    const own = m[2] === 'VDO';
    const count = Number(m[3]);
    const index = Number(m[4]);
    const seq = m[5] ?? '';
    const channel = m[6] ? m[6].toUpperCase() : undefined;
    const payload = m[7]!;
    const fill = Number(m[8]);
    if (count < 1 || index < 1 || index > count) return { kind: 'invalid', reason: 'bad fragment numbering' };
    this.expire(nowMs);
    let full: string;
    let fillBits: number;
    if (count === 1) {
      full = payload;
      fillBits = fill;
    } else {
      const key = `${seq}:${channel ?? ''}:${m[1]}${m[2]}`;
      let p = this.pending.get(key);
      if (index === 1) {
        p = { parts: [payload], fill, at: nowMs, count };
        this.pending.set(key, p);
        if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
        return { kind: 'fragment' };
      }
      if (!p || p.count !== count || p.parts.length !== index - 1) {
        this.pending.delete(key);
        return { kind: 'invalid', reason: 'fragment out of order' };
      }
      p.parts.push(payload);
      p.fill = fill;
      if (index < count) return { kind: 'fragment' };
      this.pending.delete(key);
      full = p.parts.join('');
      fillBits = p.fill;
    }
    const bits = payloadBits(full, fillBits);
    if (!bits) return { kind: 'invalid', reason: 'bad payload armouring' };
    const message = decodeMessage(bits);
    if (typeof message === 'string')
      return message.endsWith('not decoded')
        ? { kind: 'ignored', reason: message }
        : { kind: 'invalid', reason: message };
    return { kind: 'message', message, ...(channel ? { channel } : {}), own };
  }

  private expire(nowMs: number): void {
    for (const [k, p] of this.pending) if (nowMs - p.at > FRAGMENT_TTL_MS) this.pending.delete(k);
  }
}
