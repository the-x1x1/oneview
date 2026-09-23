import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  MAX_MANIFEST_BYTES,
  WORLDPACK_MANIFEST_PATH,
  compareSemver,
  parseWorldPackManifest,
  type WorldPackContentKind,
  type WorldPackManifest,
} from './manifest.js';
import {
  MAX_SIGNATURE_BYTES,
  WORLDPACK_SIGNATURE_PATH,
  checkSignature,
  formatKeyId,
  type PackSignature,
  type TrustedPublisher,
} from './signature.js';
import { ZipFormatError, ZipReader, type ZipEntry, type ZipReaderLimits } from './zip.js';

/**
 * Verification of a `.worldpack` file (ADR-007 import rules), used by
 * `worldpack verify`, by the registry before installation and — with a sink —
 * by extraction into a staging directory.
 *
 * Order matters: the archive structure and every entry name/size/flag are checked
 * by ZipReader.open before anything is inflated; the manifest is then read (bounded)
 * and validated; its signature, when there is one, is checked against the manifest's exact
 * bytes; entries are cross-checked against it; only then is data streamed, with CRC-32 and
 * SHA-256 compared as each entry completes.
 */
export interface VerifiedEntry {
  path: string;
  kind: WorldPackContentKind;
  sizeBytes: number;
  compressedBytes: number;
  sha256: string;
  crc32: number;
}

export interface WorldPackVerification {
  ok: boolean;
  file: string;
  sizeBytes: number;
  manifest?: WorldPackManifest;
  /** Who signed the manifest, when the archive got that far. */
  signature?: PackSignature;
  entries: VerifiedEntry[];
  /** Fatal problems; the pack must not be used. */
  issues: string[];
  /** Non-fatal notes (expired, needs a newer app than the one given). */
  warnings: string[];
}

export interface VerifyOptions {
  limits?: ZipReaderLimits;
  /** When given, packs whose minimumAppVersion is newer are reported as an issue. */
  appVersion?: string;
  /** Clock for expiry checks (ms since epoch). */
  now?: number;
  /** The operator's trusted publishers; a signature by one of them reads as trusted. */
  trustedPublishers?: readonly TrustedPublisher[];
  /** Refuse any pack not signed by a trusted publisher. */
  requireTrusted?: boolean;
}

type EntrySink = (entry: ZipEntry, chunk: Uint8Array) => void | Promise<void>;

interface EntryStreams {
  open(entry: ZipEntry): Promise<EntrySink>;
  close(entry: ZipEntry): Promise<void>;
  /** Called once with the validated manifest bytes, and its signature file when there is one (after every pre-extraction check passed). */
  manifest(bytes: Uint8Array, signature: Uint8Array | undefined): Promise<void>;
}

export async function verifyWorldPack(file: string, opts: VerifyOptions = {}): Promise<WorldPackVerification> {
  return processArchive(file, opts, undefined);
}

/**
 * Verify and extract into `targetDir` (must not exist). On any failure the
 * directory is removed again so a half-written pack can never be picked up.
 */
export async function extractWorldPack(
  file: string,
  targetDir: string,
  opts: VerifyOptions = {},
): Promise<WorldPackVerification> {
  await fs.mkdir(targetDir, { recursive: false });
  const handles = new Map<string, fs.FileHandle>();
  const streams: EntryStreams = {
    async open(entry) {
      const target = path.join(targetDir, ...entry.name.split('/'));
      const rel = path.relative(targetDir, target);
      if (rel.startsWith('..') || path.isAbsolute(rel))
        throw new ZipFormatError('entry escapes the target directory', entry.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const handle = await fs.open(target, 'wx');
      handles.set(entry.name, handle);
      return async (_e, chunk) => {
        await handle.write(chunk);
      };
    },
    async close(entry) {
      const handle = handles.get(entry.name);
      if (!handle) return;
      handles.delete(entry.name);
      await handle.sync();
      await handle.close();
    },
    async manifest(bytes, signature) {
      await fs.writeFile(path.join(targetDir, WORLDPACK_MANIFEST_PATH), bytes, { flag: 'wx' });
      if (signature) await fs.writeFile(path.join(targetDir, WORLDPACK_SIGNATURE_PATH), signature, { flag: 'wx' });
    },
  };
  let result: WorldPackVerification;
  try {
    result = await processArchive(file, opts, streams);
  } finally {
    for (const h of handles.values()) await h.close().catch(() => undefined);
  }
  if (!result.ok) await fs.rm(targetDir, { recursive: true, force: true });
  return result;
}

/** Read and validate only the manifest (for `inspect`). Structural checks still run. */
export async function readWorldPackManifest(
  file: string,
  limits?: ZipReaderLimits,
): Promise<
  | { ok: true; manifest: WorldPackManifest; entries: ZipEntry[]; signature: PackSignature }
  | { ok: false; issues: string[] }
> {
  let reader: ZipReader;
  try {
    reader = await ZipReader.open(file, limits);
  } catch (err) {
    return { ok: false, issues: [errorText(err)] };
  }
  try {
    const bytes = await readManifestEntry(reader);
    const parsed = parseJson(bytes);
    if (!parsed.ok) return { ok: false, issues: [parsed.error] };
    const m = parseWorldPackManifest(parsed.value);
    if (!m.ok) return { ok: false, issues: m.issues.map((i) => `manifest: ${i}`) };
    const signature = checkSignature(bytes, await readSignatureEntry(reader));
    return { ok: true, manifest: m.manifest, entries: [...reader.entries()], signature };
  } catch (err) {
    return { ok: false, issues: [errorText(err)] };
  } finally {
    await reader.close();
  }
}

async function readManifestEntry(reader: ZipReader): Promise<Buffer> {
  const entry = reader.entry(WORLDPACK_MANIFEST_PATH);
  if (!entry) throw new ZipFormatError(`${WORLDPACK_MANIFEST_PATH} not found in archive`);
  return reader.readEntry(WORLDPACK_MANIFEST_PATH, { maxBytes: MAX_MANIFEST_BYTES });
}

/**
 * The signature file's bytes, or undefined when the pack is unsigned. An oversized one is not
 * inflated: a stand-in one byte over the limit fails its check with the size as the reason.
 */
async function readSignatureEntry(reader: ZipReader): Promise<Buffer | undefined> {
  const entry = reader.entry(WORLDPACK_SIGNATURE_PATH);
  if (!entry) return undefined;
  if (entry.uncompressedSize > MAX_SIGNATURE_BYTES) return Buffer.alloc(MAX_SIGNATURE_BYTES + 1);
  return reader.readEntry(WORLDPACK_SIGNATURE_PATH, { maxBytes: MAX_SIGNATURE_BYTES });
}

async function processArchive(
  file: string,
  opts: VerifyOptions,
  streams: EntryStreams | undefined,
): Promise<WorldPackVerification> {
  const result: WorldPackVerification = { ok: false, file, sizeBytes: 0, entries: [], issues: [], warnings: [] };
  let reader: ZipReader;
  try {
    reader = await ZipReader.open(file, opts.limits);
  } catch (err) {
    result.issues.push(errorText(err));
    return result;
  }
  result.sizeBytes = reader.fileSize;
  try {
    // 1. manifest
    let manifest: WorldPackManifest;
    let manifestBytes: Buffer;
    try {
      manifestBytes = await readManifestEntry(reader);
      const parsed = parseJson(manifestBytes);
      if (!parsed.ok) {
        result.issues.push(parsed.error);
        return result;
      }
      const m = parseWorldPackManifest(parsed.value);
      if (!m.ok) {
        result.issues.push(...m.issues.map((i) => `manifest: ${i}`));
        return result;
      }
      manifest = m.manifest;
    } catch (err) {
      result.issues.push(errorText(err));
      return result;
    }
    result.manifest = manifest;

    // 2. the signature over those exact bytes: a broken one is refused whatever the trust settings
    let signatureBytes: Buffer | undefined;
    try {
      signatureBytes = await readSignatureEntry(reader);
    } catch (err) {
      result.issues.push(`signature: ${errorText(err)}`);
      return result;
    }
    const signature = checkSignature(manifestBytes, signatureBytes, opts.trustedPublishers);
    result.signature = signature;
    if (signature.status === 'invalid') {
      result.issues.push(`signature: ${signature.reason}`);
      return result;
    }
    if (opts.requireTrusted && !(signature.status === 'signed' && signature.trusted)) {
      result.issues.push(
        signature.status === 'signed'
          ? `signed by key ${formatKeyId(signature.keyId)}, which is not one of your trusted publishers`
          : signature.status === 'unchecked'
            ? `the signature could not be checked here (${signature.reason})`
            : 'the pack is not signed, and only packs signed by a trusted publisher are installed',
      );
      return result;
    }

    // 3. cross-check entries ↔ manifest before touching data
    const byPath = new Map(manifest.contents.map((c) => [c.path, c] as const));
    const entries = reader.entries();
    const entryNames = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      if (e.name === WORLDPACK_MANIFEST_PATH || e.name === WORLDPACK_SIGNATURE_PATH) continue;
      const c = byPath.get(e.name);
      if (!c) {
        result.issues.push(`archive entry "${e.name}" is not listed in the manifest`);
        continue;
      }
      if (c.sizeBytes !== e.uncompressedSize)
        result.issues.push(`"${e.name}": manifest says ${c.sizeBytes} bytes, archive declares ${e.uncompressedSize}`);
    }
    for (const c of manifest.contents)
      if (!entryNames.has(c.path)) result.issues.push(`manifest lists "${c.path}" but the archive has no such entry`);
    if (opts.appVersion !== undefined && compareSemver(opts.appVersion, manifest.minimumAppVersion) < 0)
      result.issues.push(`pack requires app version >= ${manifest.minimumAppVersion} (this app is ${opts.appVersion})`);
    if (manifest.expiresAt !== undefined && (opts.now ?? Date.now()) > Date.parse(manifest.expiresAt))
      result.warnings.push(`pack expired on ${manifest.expiresAt}`);
    if (result.issues.length > 0) return result;

    // 4. stream every content entry, verifying CRC-32 (zip) and SHA-256 (manifest)
    if (streams) {
      try {
        await streams.manifest(manifestBytes, signatureBytes);
      } catch (err) {
        result.issues.push(errorText(err));
        return result;
      }
    }
    for (const e of entries) {
      if (e.name === WORLDPACK_MANIFEST_PATH || e.name === WORLDPACK_SIGNATURE_PATH) continue;
      const c = byPath.get(e.name)!;
      let sink: EntrySink | undefined;
      try {
        if (streams) sink = await streams.open(e);
        const r = await reader.streamEntry(e, sink ? (chunk) => sink!(e, chunk) : () => undefined);
        if (streams) await streams.close(e);
        if (r.sha256 !== c.sha256) {
          result.issues.push(
            `"${e.name}": SHA-256 mismatch (manifest ${c.sha256.slice(0, 12)}…, actual ${r.sha256.slice(0, 12)}…)`,
          );
          return result;
        }
        result.entries.push({
          path: e.name,
          kind: c.kind,
          sizeBytes: r.size,
          compressedBytes: e.compressedSize,
          sha256: r.sha256,
          crc32: r.crc32,
        });
      } catch (err) {
        if (streams) await streams.close(e).catch(() => undefined);
        result.issues.push(errorText(err));
        return result;
      }
    }
    result.ok = true;
    return result;
  } finally {
    await reader.close();
  }
}

function parseJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown };
  } catch (err) {
    return { ok: false, error: `manifest.json is not valid JSON: ${errorText(err)}` };
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatVerification(v: WorldPackVerification): string {
  const lines: string[] = [];
  lines.push(`${v.ok ? 'OK  ' : 'FAIL'} ${v.file} (${v.sizeBytes} bytes)`);
  if (v.manifest)
    lines.push(
      `     ${v.manifest.id} — ${v.manifest.name} · created ${v.manifest.createdAt} · min app ${v.manifest.minimumAppVersion}`,
    );
  if (v.signature) lines.push(`     ${signatureLine(v.signature)}`);
  for (const e of v.entries)
    lines.push(
      `     ✓ ${e.path.padEnd(32)} ${e.kind.padEnd(12)} ${String(e.sizeBytes).padStart(12)} B  sha256 ${e.sha256.slice(0, 16)}…`,
    );
  for (const w of v.warnings) lines.push(`     warning: ${w}`);
  for (const i of v.issues) lines.push(`     issue: ${i}`);
  return lines.join('\n');
}

/** One line on who signed a pack, for the CLI and the log. */
export function signatureLine(sig: PackSignature): string {
  switch (sig.status) {
    case 'unsigned':
      return 'not signed — files are checked, who built the pack is not known';
    case 'invalid':
      return `signature INVALID — ${sig.reason}`;
    case 'unchecked':
      return `signed by key ${formatKeyId(sig.keyId)} — not checked: ${sig.reason}`;
    case 'signed':
      return sig.trusted
        ? `signed by ${sig.publisher ?? 'a trusted publisher'} (key ${formatKeyId(sig.keyId)})`
        : `signed by key ${formatKeyId(sig.keyId)} — not one of your trusted publishers`;
  }
}
