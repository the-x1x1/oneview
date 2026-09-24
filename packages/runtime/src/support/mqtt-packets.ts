/**
 * MQTT 3.1.1 packets, the four the client needs to send and the five it needs to read
 * (OASIS MQTT 3.1.1, sections 2 and 3). A pure codec: bytes in, packets out, no I/O — so
 * the connection code stays small and the codec can be tested byte for byte. No client
 * library is used: the runtime speaks only what it needs, and every size is bounded here.
 */
export const enum PacketType {
  CONNECT = 1,
  CONNACK = 2,
  PUBLISH = 3,
  PUBACK = 4,
  SUBSCRIBE = 8,
  SUBACK = 9,
  UNSUBSCRIBE = 10,
  PINGREQ = 12,
  PINGRESP = 13,
  DISCONNECT = 14,
}

/** The largest remaining length the client will accept (a PUBLISH past this is a protocol fault). */
export const MAX_PACKET_BYTES = 4 * 1024 * 1024;
const MAX_STRING_BYTES = 65535;

export interface ConnectOptions {
  clientId: string;
  keepAliveSeconds: number;
  username?: string;
  password?: string;
  cleanSession?: boolean;
}

function utf8(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength > MAX_STRING_BYTES) throw new Error('MQTT string over 65535 bytes');
  return bytes;
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + bytes.byteLength);
  out[0] = bytes.byteLength >> 8;
  out[1] = bytes.byteLength & 0xff;
  out.set(bytes, 2);
  return out;
}

function encodeRemainingLength(n: number): Uint8Array {
  const out: number[] = [];
  let x = n;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    out.push(byte);
  } while (x > 0);
  return Uint8Array.from(out);
}

type Bytes = Uint8Array<ArrayBufferLike>;

function concat(parts: Bytes[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function packet(typeAndFlags: number, body: Bytes): Uint8Array {
  return concat([Uint8Array.of(typeAndFlags), encodeRemainingLength(body.byteLength), body]);
}

export function encodeConnect(o: ConnectOptions): Uint8Array {
  let flags = 0;
  if (o.cleanSession !== false) flags |= 0x02;
  if (o.username !== undefined) flags |= 0x80;
  if (o.password !== undefined) flags |= 0x40;
  const parts = [
    lengthPrefixed(utf8('MQTT')),
    Uint8Array.of(4, flags, o.keepAliveSeconds >> 8, o.keepAliveSeconds & 0xff),
    lengthPrefixed(utf8(o.clientId)),
  ];
  if (o.username !== undefined) parts.push(lengthPrefixed(utf8(o.username)));
  if (o.password !== undefined) parts.push(lengthPrefixed(utf8(o.password)));
  return packet(PacketType.CONNECT << 4, concat(parts));
}

export function encodeSubscribe(packetId: number, topics: Array<{ topic: string; qos: 0 | 1 }>): Uint8Array {
  const parts: Bytes[] = [Uint8Array.of(packetId >> 8, packetId & 0xff)];
  for (const t of topics) parts.push(lengthPrefixed(utf8(t.topic)), Uint8Array.of(t.qos));
  return packet((PacketType.SUBSCRIBE << 4) | 0x02, concat(parts));
}

export function encodePuback(packetId: number): Uint8Array {
  return packet(PacketType.PUBACK << 4, Uint8Array.of(packetId >> 8, packetId & 0xff));
}

export function encodePingreq(): Uint8Array {
  return Uint8Array.of(PacketType.PINGREQ << 4, 0);
}

export function encodeDisconnect(): Uint8Array {
  return Uint8Array.of(PacketType.DISCONNECT << 4, 0);
}

export type DecodedPacket =
  | { type: 'connack'; sessionPresent: boolean; returnCode: number }
  | {
      type: 'publish';
      topic: string;
      payload: Uint8Array;
      qos: number;
      retained: boolean;
      dup: boolean;
      packetId?: number;
    }
  | { type: 'puback'; packetId: number }
  | { type: 'suback'; packetId: number; returnCodes: number[] }
  | { type: 'pingresp' }
  | { type: 'other'; packetType: number };

export const CONNACK_REASONS: Record<number, string> = {
  0: 'accepted',
  1: 'unacceptable protocol version',
  2: 'identifier rejected',
  3: 'server unavailable',
  4: 'bad user name or password',
  5: 'not authorized',
};

/**
 * Reads whole packets from a growing buffer. `push` returns the packets completed by the
 * bytes so far and keeps the remainder; a remaining length past `MAX_PACKET_BYTES`, or a
 * malformed header, throws — the connection is then closed rather than guessed at.
 */
export class PacketReader {
  private buffer: Bytes = new Uint8Array(0);

  push(chunk: Bytes): DecodedPacket[] {
    this.buffer = this.buffer.byteLength ? concat([this.buffer, chunk]) : chunk;
    const out: DecodedPacket[] = [];
    for (;;) {
      const framed = this.frame();
      if (!framed) return out;
      out.push(decode(framed.typeAndFlags, framed.body));
    }
  }

  private frame(): { typeAndFlags: number; body: Bytes } | undefined {
    const b = this.buffer;
    if (b.byteLength < 2) return undefined;
    let length = 0;
    let multiplier = 1;
    let i = 1;
    for (;;) {
      if (i >= b.byteLength) return undefined;
      const byte = b[i]!;
      length += (byte & 0x7f) * multiplier;
      if (multiplier > 128 * 128 * 128) throw new Error('MQTT remaining length is malformed');
      multiplier *= 128;
      i++;
      if ((byte & 0x80) === 0) break;
    }
    if (length > MAX_PACKET_BYTES) throw new Error(`MQTT packet of ${length} bytes exceeds ${MAX_PACKET_BYTES}`);
    if (b.byteLength < i + length) return undefined;
    const body = b.subarray(i, i + length);
    this.buffer = b.subarray(i + length);
    return { typeAndFlags: b[0]!, body };
  }
}

function readString(body: Bytes, at: number): { value: string; next: number } {
  if (at + 2 > body.byteLength) throw new Error('MQTT string truncated');
  const len = (body[at]! << 8) | body[at + 1]!;
  if (at + 2 + len > body.byteLength) throw new Error('MQTT string truncated');
  return { value: new TextDecoder().decode(body.subarray(at + 2, at + 2 + len)), next: at + 2 + len };
}

export function decode(typeAndFlags: number, body: Bytes): DecodedPacket {
  const type = typeAndFlags >> 4;
  switch (type) {
    case PacketType.CONNACK:
      if (body.byteLength < 2) throw new Error('CONNACK truncated');
      return { type: 'connack', sessionPresent: (body[0]! & 0x01) === 1, returnCode: body[1]! };
    case PacketType.PUBLISH: {
      const dup = (typeAndFlags & 0x08) !== 0;
      const qos = (typeAndFlags & 0x06) >> 1;
      const retained = (typeAndFlags & 0x01) !== 0;
      if (qos === 3) throw new Error('PUBLISH with QoS 3');
      const topic = readString(body, 0);
      let at = topic.next;
      let packetId: number | undefined;
      if (qos > 0) {
        if (at + 2 > body.byteLength) throw new Error('PUBLISH truncated');
        packetId = (body[at]! << 8) | body[at + 1]!;
        at += 2;
      }
      return {
        type: 'publish',
        topic: topic.value,
        payload: body.subarray(at),
        qos,
        retained,
        dup,
        ...(packetId !== undefined ? { packetId } : {}),
      };
    }
    case PacketType.PUBACK:
      if (body.byteLength < 2) throw new Error('PUBACK truncated');
      return { type: 'puback', packetId: (body[0]! << 8) | body[1]! };
    case PacketType.SUBACK: {
      if (body.byteLength < 2) throw new Error('SUBACK truncated');
      return { type: 'suback', packetId: (body[0]! << 8) | body[1]!, returnCodes: [...body.subarray(2)] };
    }
    case PacketType.PINGRESP:
      return { type: 'pingresp' };
    default:
      return { type: 'other', packetType: type };
  }
}

/** Whether a topic matches a subscription filter (`+` one level, `#` the rest; `$` topics only by explicit filter). */
export function topicMatches(filter: string, topic: string): boolean {
  if (topic.startsWith('$') && !filter.startsWith('$')) return false;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    const part = f[i]!;
    if (part === '#') return true;
    if (i >= t.length) return false;
    if (part !== '+' && part !== t[i]) return false;
  }
  return f.length === t.length;
}

/** A subscription filter the client will send: not empty, `#` only last, `+` only as a whole level. */
export function isValidTopicFilter(filter: string): boolean {
  if (!filter || filter.length > 1024 || filter.includes('\0')) return false;
  const parts = filter.split('/');
  return parts.every((p, i) => {
    if (p === '#') return i === parts.length - 1;
    if (p === '+') return true;
    return !p.includes('#') && !p.includes('+');
  });
}
