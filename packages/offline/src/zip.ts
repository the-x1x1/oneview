/**
 * Minimal, safe ZIP container for `.worldpack` files.
 *
 * Scope on purpose: local file headers + central directory, methods STORE (0) and
 * DEFLATE (8, raw deflate via node:zlib), no zip64 (archives and entries above
 * 4 GiB are refused), no encryption, no data descriptors written, no directory
 * entries. The reader validates the whole central directory (names, flags, sizes,
 * ratios, duplicates, symlink attributes, forbidden extensions) *before* any byte
 * is inflated, and every inflation is bounded by the declared size so a lying
 * header cannot expand past it.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, createInflateRaw } from 'node:zlib';

export const ZIP_METHOD_STORE = 0;
export const ZIP_METHOD_DEFLATE = 8;
export type ZipMethod = typeof ZIP_METHOD_STORE | typeof ZIP_METHOD_DEFLATE;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const EOCD_MIN = 22;
const LOCAL_MIN = 30;
const CENTRAL_MIN = 46;
const MAX_COMMENT = 0xffff;
const MAX_32 = 0xffff_ffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const UNIX_SYMLINK = 0o120000;
const UNIX_TYPE_MASK = 0o170000;
const READ_CHUNK = 256 * 1024;

export const GIB = 1024 * 1024 * 1024;

/** Executable / script extensions that are never allowed in a data-only pack. */
export const FORBIDDEN_EXTENSIONS: readonly string[] = Object.freeze([
  '.exe', '.dll', '.js', '.mjs', '.cjs', '.ps1', '.bat', '.cmd', '.sh', '.vbs', '.scr', '.com', '.msi', '.jar', '.py',
  '.lnk', '.hta', '.wsf', '.pif', '.so', '.dylib', '.wasm', '.reg', '.app',
]);

const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SAFE_NAME = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export class ZipFormatError extends Error {
  constructor(message: string, readonly entryName?: string) {
    super(entryName ? `${message} (entry "${entryName}")` : message);
    this.name = 'ZipFormatError';
  }
}

export interface ZipReaderLimits {
  /** Maximum declared uncompressed size of a single entry (default 2 GiB). */
  maxEntryBytes?: number;
  /** Maximum sum of declared uncompressed sizes (default 8 GiB). */
  maxTotalBytes?: number;
  /** Maximum uncompressed:compressed ratio for deflated entries (default 200). */
  maxRatio?: number;
  /** Maximum number of entries (default 4096). */
  maxEntries?: number;
}

export const DEFAULT_ZIP_LIMITS: Required<ZipReaderLimits> = Object.freeze({ maxEntryBytes: 2 * GIB, maxTotalBytes: 8 * GIB, maxRatio: 200, maxEntries: 4096 });

export interface ZipEntry {
  name: string;
  method: ZipMethod;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  versionMadeBy: number;
  externalAttributes: number;
}

// ---- CRC-32 ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = (crc ^ 0xffff_ffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffff_ffff) >>> 0;
}

export function crc32(bytes: Uint8Array): number { return crc32Update(0, bytes); }

// ---- entry name policy --------------------------------------------------------

/** Returns the reason an entry name is unsafe, or undefined when it may be extracted. */
export function entryNameProblem(name: string): string | undefined {
  if (name.length === 0) return 'empty name';
  if (Buffer.byteLength(name, 'utf8') > 255) return 'name longer than 255 bytes';
  if (name !== name.normalize('NFC')) return 'name is not NFC-normalized';
  if (name.includes('\\')) return 'backslash in name';
  if (name.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'drive letter in name';
  if (name.endsWith('/')) return 'directory entries are not allowed';
  if (!SAFE_NAME.test(name)) return 'name contains characters outside [A-Za-z0-9._-/]';
  const segments = name.split('/');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return 'path traversal segment';
    if (seg.startsWith('.')) return 'hidden segment (leading dot)';
    if (WINDOWS_DEVICE_NAMES.test(seg.replace(/\..*$/, ''))) return 'reserved device name';
  }
  const last = segments[segments.length - 1]!.toLowerCase();
  for (const ext of FORBIDDEN_EXTENSIONS) if (last.endsWith(ext)) return `forbidden extension ${ext}`;
  return undefined;
}

// ---- writer -------------------------------------------------------------------

export interface ZipWriterOptions {
  /** Timestamp stamped on every entry (deterministic archives). Default 1980-01-01T00:00:00Z. */
  mtime?: Date;
  /** Deflate level 0..9 (default 6). */
  level?: number;
}

export interface ZipEntryInput {
  name: string;
  data: Uint8Array | { file: string };
  method?: ZipMethod;
}

export interface ZipWrittenEntry {
  name: string;
  method: ZipMethod;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  sha256: string;
  localHeaderOffset: number;
}

interface WriterState { handle: FileHandle; offset: number; entries: ZipWrittenEntry[]; finished: boolean }

export class ZipWriter {
  private readonly names = new Set<string>();
  private readonly dosTime: number;
  private readonly dosDate: number;
  private readonly level: number;

  private constructor(private readonly state: WriterState, opts: ZipWriterOptions) {
    const { time, date } = toDosDateTime(opts.mtime ?? new Date(Date.UTC(1980, 0, 1)));
    this.dosTime = time;
    this.dosDate = date;
    this.level = opts.level ?? 6;
  }

  static async create(file: string, opts: ZipWriterOptions = {}): Promise<ZipWriter> {
    const handle = await fs.open(file, 'w');
    return new ZipWriter({ handle, offset: 0, entries: [], finished: false }, opts);
  }

  get entries(): readonly ZipWrittenEntry[] { return this.state.entries; }

  async add(entry: ZipEntryInput): Promise<ZipWrittenEntry> {
    if (this.state.finished) throw new Error('zip writer already finished');
    const problem = entryNameProblem(entry.name);
    if (problem) throw new ZipFormatError(problem, entry.name);
    const lower = entry.name.toLowerCase();
    if (this.names.has(lower)) throw new ZipFormatError('duplicate entry name', entry.name);
    this.names.add(lower);
    const method = entry.method ?? ZIP_METHOD_DEFLATE;
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const localHeaderOffset = this.state.offset;
    const header = Buffer.alloc(LOCAL_MIN + nameBytes.length);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(this.dosTime, 10);
    header.writeUInt16LE(this.dosDate, 12);
    header.writeUInt32LE(0, 14); // crc (patched)
    header.writeUInt32LE(0, 18); // compressed size (patched)
    header.writeUInt32LE(0, 22); // uncompressed size (patched)
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    nameBytes.copy(header, LOCAL_MIN);
    await this.write(header);

    const source = entry.data instanceof Uint8Array ? Readable.from([Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength)]) : createReadStream(entry.data.file, { highWaterMark: READ_CHUNK });
    let crc = 0;
    let uncompressed = 0;
    let compressed = 0;
    const hash = createHash('sha256');
    const counted = Readable.from(countBytes(source, (chunk) => { crc = crc32Update(crc, chunk); uncompressed += chunk.length; hash.update(chunk); }));
    let output: AsyncIterable<Buffer>;
    let piped: Promise<void> | undefined;
    if (method === ZIP_METHOD_DEFLATE) {
      const deflate = createDeflateRaw({ level: this.level });
      piped = pipeline(counted, deflate);
      output = deflate;
    } else {
      output = counted;
    }
    try {
      for await (const chunk of output) {
        compressed += chunk.length;
        if (compressed > MAX_32 || uncompressed > MAX_32) throw new ZipFormatError('entry exceeds 4 GiB (zip64 is not supported)', entry.name);
        await this.write(chunk);
      }
    } finally {
      if (piped) await piped.catch(() => undefined);
    }
    if (piped) await piped;
    if (this.state.offset > MAX_32) throw new ZipFormatError('archive exceeds 4 GiB (zip64 is not supported)');

    const patch = Buffer.alloc(12);
    patch.writeUInt32LE(crc >>> 0, 0);
    patch.writeUInt32LE(compressed, 4);
    patch.writeUInt32LE(uncompressed, 8);
    await this.state.handle.write(patch, 0, patch.length, localHeaderOffset + 14);

    const written: ZipWrittenEntry = { name: entry.name, method, crc32: crc >>> 0, compressedSize: compressed, uncompressedSize: uncompressed, sha256: hash.digest('hex'), localHeaderOffset };
    this.state.entries.push(written);
    return written;
  }

  /** Write the central directory and end record, then close the file. */
  async finish(): Promise<{ entries: ZipWrittenEntry[]; sizeBytes: number }> {
    if (this.state.finished) throw new Error('zip writer already finished');
    this.state.finished = true;
    const cdOffset = this.state.offset;
    for (const e of this.state.entries) {
      const nameBytes = Buffer.from(e.name, 'utf8');
      const rec = Buffer.alloc(CENTRAL_MIN + nameBytes.length);
      rec.writeUInt32LE(SIG_CENTRAL, 0);
      rec.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, 2.0
      rec.writeUInt16LE(20, 6);
      rec.writeUInt16LE(0, 8);
      rec.writeUInt16LE(e.method, 10);
      rec.writeUInt16LE(this.dosTime, 12);
      rec.writeUInt16LE(this.dosDate, 14);
      rec.writeUInt32LE(e.crc32, 16);
      rec.writeUInt32LE(e.compressedSize, 20);
      rec.writeUInt32LE(e.uncompressedSize, 24);
      rec.writeUInt16LE(nameBytes.length, 28);
      rec.writeUInt16LE(0, 30);
      rec.writeUInt16LE(0, 32);
      rec.writeUInt16LE(0, 34);
      rec.writeUInt16LE(0, 36);
      rec.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      rec.writeUInt32LE(e.localHeaderOffset, 42);
      nameBytes.copy(rec, CENTRAL_MIN);
      await this.write(rec);
    }
    const cdSize = this.state.offset - cdOffset;
    if (this.state.entries.length > 0xffff || this.state.offset > MAX_32) throw new ZipFormatError('archive exceeds zip32 limits');
    const eocd = Buffer.alloc(EOCD_MIN);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.state.entries.length, 8);
    eocd.writeUInt16LE(this.state.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await this.write(eocd);
    await this.state.handle.sync();
    await this.state.handle.close();
    return { entries: [...this.state.entries], sizeBytes: this.state.offset };
  }

  /** Close without a valid end record (used when a build aborts). */
  async abort(): Promise<void> {
    if (this.state.finished) return;
    this.state.finished = true;
    await this.state.handle.close();
  }

  private async write(chunk: Uint8Array): Promise<void> {
    let off = 0;
    while (off < chunk.length) {
      const r = await this.state.handle.write(chunk, off, chunk.length - off, this.state.offset);
      off += r.bytesWritten;
      this.state.offset += r.bytesWritten;
    }
  }
}

async function* countBytes(source: AsyncIterable<Buffer | Uint8Array | string>, onChunk: (chunk: Uint8Array) => void): AsyncGenerator<Buffer> {
  for await (const raw of source) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    onChunk(chunk);
    yield chunk;
  }
}

function toDosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | Math.max(1, d.getUTCDate());
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  return { time, date };
}

// ---- reader -------------------------------------------------------------------

export interface ZipStreamResult { crc32: number; sha256: string; size: number }

export class ZipReader {
  private constructor(
    private readonly handle: FileHandle,
    readonly fileSize: number,
    private readonly list: ZipEntry[],
    private readonly centralDirectoryOffset: number,
  ) {}

  /**
   * Open and validate an archive. Throws ZipFormatError when anything about the
   * structure or the entry table is unsafe; nothing is inflated here.
   */
  static async open(file: string, limits: ZipReaderLimits = {}): Promise<ZipReader> {
    const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const size = stat.size;
      if (size < EOCD_MIN) throw new ZipFormatError('file too small to be a zip archive');
      if (size > MAX_32) throw new ZipFormatError('archive exceeds 4 GiB (zip64 is not supported)');
      const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
      const tail = Buffer.alloc(tailLen);
      await readExact(handle, tail, size - tailLen);
      let eocdRel = -1;
      for (let i = tailLen - EOCD_MIN; i >= 0; i--) {
        if (tail.readUInt32LE(i) === SIG_EOCD) { eocdRel = i; break; }
      }
      if (eocdRel < 0) throw new ZipFormatError('end of central directory record not found (truncated or not a zip)');
      const eocdPos = size - tailLen + eocdRel;
      const diskNo = tail.readUInt16LE(eocdRel + 4);
      const cdDisk = tail.readUInt16LE(eocdRel + 6);
      const entriesOnDisk = tail.readUInt16LE(eocdRel + 8);
      const totalEntries = tail.readUInt16LE(eocdRel + 10);
      const cdSize = tail.readUInt32LE(eocdRel + 12);
      const cdOffset = tail.readUInt32LE(eocdRel + 16);
      const commentLen = tail.readUInt16LE(eocdRel + 20);
      if (eocdPos + EOCD_MIN + commentLen !== size) throw new ZipFormatError('trailing data after end of central directory');
      if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) throw new ZipFormatError('multi-disk archives are not supported');
      if (totalEntries === 0xffff || cdSize === MAX_32 || cdOffset === MAX_32) throw new ZipFormatError('zip64 archives are not supported');
      if (eocdRel >= 20 && tail.readUInt32LE(eocdRel - 20) === SIG_ZIP64_LOCATOR) throw new ZipFormatError('zip64 archives are not supported');
      if (totalEntries === 0) throw new ZipFormatError('archive has no entries');
      if (totalEntries > lim.maxEntries) throw new ZipFormatError(`archive has ${totalEntries} entries (limit ${lim.maxEntries})`);
      if (cdOffset + cdSize !== eocdPos) throw new ZipFormatError('central directory does not end at the end record (prepended data or corruption)');
      if (cdSize < totalEntries * CENTRAL_MIN) throw new ZipFormatError('central directory too small for declared entry count');

      const cd = Buffer.alloc(cdSize);
      await readExact(handle, cd, cdOffset);
      const entries: ZipEntry[] = [];
      const seen = new Set<string>();
      let pos = 0;
      let total = 0;
      for (let i = 0; i < totalEntries; i++) {
        if (pos + CENTRAL_MIN > cd.length) throw new ZipFormatError('central directory truncated');
        const sig = cd.readUInt32LE(pos);
        if (sig === SIG_ZIP64_EOCD) throw new ZipFormatError('zip64 archives are not supported');
        if (sig !== SIG_CENTRAL) throw new ZipFormatError(`bad central directory signature at entry ${i}`);
        const versionMadeBy = cd.readUInt16LE(pos + 4);
        const flags = cd.readUInt16LE(pos + 8);
        const method = cd.readUInt16LE(pos + 10);
        const crc = cd.readUInt32LE(pos + 16);
        const compressedSize = cd.readUInt32LE(pos + 20);
        const uncompressedSize = cd.readUInt32LE(pos + 24);
        const nameLen = cd.readUInt16LE(pos + 28);
        const extraLen = cd.readUInt16LE(pos + 30);
        const commentLen2 = cd.readUInt16LE(pos + 32);
        const diskStart = cd.readUInt16LE(pos + 34);
        const externalAttributes = cd.readUInt32LE(pos + 38);
        const localHeaderOffset = cd.readUInt32LE(pos + 42);
        const recEnd = pos + CENTRAL_MIN + nameLen + extraLen + commentLen2;
        if (recEnd > cd.length) throw new ZipFormatError('central directory entry overruns directory');
        const name = cd.subarray(pos + CENTRAL_MIN, pos + CENTRAL_MIN + nameLen).toString('utf8');
        const extra = cd.subarray(pos + CENTRAL_MIN + nameLen, pos + CENTRAL_MIN + nameLen + extraLen);
        pos = recEnd;

        const problem = entryNameProblem(name);
        if (problem) throw new ZipFormatError(problem, name);
        const lower = name.toLowerCase();
        if (seen.has(lower)) throw new ZipFormatError('duplicate entry name', name);
        seen.add(lower);
        if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ZipFormatError('encrypted entries are not supported', name);
        if (method !== ZIP_METHOD_STORE && method !== ZIP_METHOD_DEFLATE) throw new ZipFormatError(`unsupported compression method ${method}`, name);
        if (compressedSize === MAX_32 || uncompressedSize === MAX_32 || localHeaderOffset === MAX_32 || diskStart !== 0) throw new ZipFormatError('zip64 entries are not supported', name);
        if (hasZip64Extra(extra)) throw new ZipFormatError('zip64 extra field present', name);
        if ((versionMadeBy >> 8) === 3 && (((externalAttributes >>> 16) & UNIX_TYPE_MASK) === UNIX_SYMLINK)) throw new ZipFormatError('symbolic links are not allowed', name);
        if (uncompressedSize > lim.maxEntryBytes) throw new ZipFormatError(`entry declares ${uncompressedSize} bytes (limit ${lim.maxEntryBytes})`, name);
        if (method === ZIP_METHOD_STORE && compressedSize !== uncompressedSize) throw new ZipFormatError('stored entry with mismatched sizes', name);
        if (method === ZIP_METHOD_DEFLATE) {
          if (compressedSize === 0 && uncompressedSize > 0) throw new ZipFormatError('deflated entry with zero compressed size', name);
          if (compressedSize > 0 && uncompressedSize / compressedSize > lim.maxRatio) throw new ZipFormatError(`compression ratio ${Math.round(uncompressedSize / compressedSize)}:1 exceeds ${lim.maxRatio}:1`, name);
        }
        if (localHeaderOffset + LOCAL_MIN + nameLen > cdOffset) throw new ZipFormatError('local header lies outside the data area', name);
        if (localHeaderOffset + LOCAL_MIN + nameLen + compressedSize > cdOffset) throw new ZipFormatError('entry data overruns the central directory (truncated or lying sizes)', name);
        total += uncompressedSize;
        if (total > lim.maxTotalBytes) throw new ZipFormatError(`total declared size exceeds ${lim.maxTotalBytes} bytes`);
        entries.push({ name, method: method as ZipMethod, flags, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset, versionMadeBy, externalAttributes });
      }
      if (pos !== cd.length) throw new ZipFormatError('unexpected bytes after the last central directory entry');
      return new ZipReader(handle, size, entries, cdOffset);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  entries(): readonly ZipEntry[] { return this.list; }
  entry(name: string): ZipEntry | undefined { return this.list.find((e) => e.name === name); }

  async close(): Promise<void> { await this.handle.close(); }

  /** Read one entry fully into memory (bounded by maxBytes, default 16 MiB). */
  async readEntry(name: string, opts: { maxBytes?: number } = {}): Promise<Buffer> {
    const e = this.entry(name);
    if (!e) throw new ZipFormatError('entry not found', name);
    const max = opts.maxBytes ?? 16 * 1024 * 1024;
    if (e.uncompressedSize > max) throw new ZipFormatError(`entry larger than ${max} bytes`, name);
    const chunks: Buffer[] = [];
    await this.streamEntry(e, (c) => { chunks.push(Buffer.from(c)); });
    return Buffer.concat(chunks);
  }

  /**
   * Inflate one entry through `sink`, bounded by the declared size; verifies the
   * local header against the central directory and the CRC-32 at the end.
   */
  async streamEntry(entry: ZipEntry, sink: (chunk: Uint8Array) => void | Promise<void>): Promise<ZipStreamResult> {
    const local = Buffer.alloc(LOCAL_MIN);
    await readExact(this.handle, local, entry.localHeaderOffset);
    if (local.readUInt32LE(0) !== SIG_LOCAL) throw new ZipFormatError('bad local header signature', entry.name);
    const localFlags = local.readUInt16LE(6);
    const localMethod = local.readUInt16LE(8);
    const nameLen = local.readUInt16LE(26);
    const extraLen = local.readUInt16LE(28);
    if (localFlags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ZipFormatError('encrypted entries are not supported', entry.name);
    if (localMethod !== entry.method) throw new ZipFormatError('local header method differs from central directory', entry.name);
    const nameBuf = Buffer.alloc(nameLen);
    await readExact(this.handle, nameBuf, entry.localHeaderOffset + LOCAL_MIN);
    if (nameBuf.toString('utf8') !== entry.name) throw new ZipFormatError('local header name differs from central directory', entry.name);
    if (!(localFlags & FLAG_DATA_DESCRIPTOR)) {
      const lc = local.readUInt32LE(14), lcs = local.readUInt32LE(18), lus = local.readUInt32LE(22);
      if (lc !== entry.crc32 || lcs !== entry.compressedSize || lus !== entry.uncompressedSize) throw new ZipFormatError('local header sizes differ from central directory', entry.name);
    }
    const dataStart = entry.localHeaderOffset + LOCAL_MIN + nameLen + extraLen;
    if (dataStart + entry.compressedSize > this.centralDirectoryOffset) throw new ZipFormatError('entry data overruns the central directory', entry.name);

    const compressed = readRange(this.handle, dataStart, entry.compressedSize);
    let output: AsyncIterable<Buffer>;
    let piped: Promise<void> | undefined;
    if (entry.method === ZIP_METHOD_DEFLATE) {
      const inflate = createInflateRaw();
      piped = pipeline(Readable.from(compressed), inflate);
      output = inflate;
    } else {
      output = compressed;
    }
    let produced = 0;
    let crc = 0;
    const hash = createHash('sha256');
    try {
      for await (const chunk of output) {
        produced += chunk.length;
        if (produced > entry.uncompressedSize) throw new ZipFormatError(`inflated data exceeds the declared ${entry.uncompressedSize} bytes`, entry.name);
        crc = crc32Update(crc, chunk);
        hash.update(chunk);
        await sink(chunk);
      }
    } catch (err) {
      if (piped) await piped.catch(() => undefined);
      if (err instanceof ZipFormatError) throw err;
      throw new ZipFormatError(`inflate failed: ${err instanceof Error ? err.message : String(err)}`, entry.name);
    }
    if (piped) {
      try { await piped; } catch (err) { throw new ZipFormatError(`inflate failed: ${err instanceof Error ? err.message : String(err)}`, entry.name); }
    }
    if (produced !== entry.uncompressedSize) throw new ZipFormatError(`inflated ${produced} bytes, declared ${entry.uncompressedSize}`, entry.name);
    if ((crc >>> 0) !== entry.crc32) throw new ZipFormatError('CRC-32 mismatch', entry.name);
    return { crc32: crc >>> 0, sha256: hash.digest('hex'), size: produced };
  }
}

function hasZip64Extra(extra: Buffer): boolean {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) return true;
    p += 4 + len;
  }
  return false;
}

async function readExact(handle: FileHandle, into: Buffer, position: number): Promise<void> {
  let off = 0;
  while (off < into.length) {
    const r = await handle.read(into, off, into.length - off, position + off);
    if (r.bytesRead === 0) throw new ZipFormatError('unexpected end of file (truncated archive)');
    off += r.bytesRead;
  }
}

async function* readRange(handle: FileHandle, start: number, length: number): AsyncGenerator<Buffer> {
  let remaining = length;
  let pos = start;
  while (remaining > 0) {
    const n = Math.min(READ_CHUNK, remaining);
    const buf = Buffer.alloc(n);
    await readExact(handle, buf, pos);
    pos += n;
    remaining -= n;
    yield buf;
  }
}
