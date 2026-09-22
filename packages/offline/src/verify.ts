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
import { ZipFormatError, ZipReader, type ZipEntry, type ZipReaderLimits } from './zip.js';

/**
 * Verification of a `.worldpack` file (ADR-007 import rules), used by
 * `worldpack verify`, by the registry before installation and — with a sink —
 * by extraction into a staging directory.
 *
 * Order matters: the archive structure and every entry name/size/flag are checked
 * by ZipReader.open before anything is inflated; the manifest is then read (bounded)
 * and validated; entries are cross-checked against it; only then is data streamed,
 * with CRC-32 and SHA-256 compared as each entry completes.
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
}

type EntrySink = (entry: ZipEntry, chunk: Uint8Array) => void | Promise<void>;

interface EntryStreams {
  open(entry: ZipEntry): Promise<EntrySink>;
  close(entry: ZipEntry): Promise<void>;
  /** Called once with the validated manifest bytes (after every pre-extraction check passed). */
  manifest(bytes: Uint8Array): Promise<void>;
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
    async manifest(bytes) {
      await fs.writeFile(path.join(targetDir, WORLDPACK_MANIFEST_PATH), bytes, { flag: 'wx' });
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
): Promise<{ ok: true; manifest: WorldPackManifest; entries: ZipEntry[] } | { ok: false; issues: string[] }> {
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
    return { ok: true, manifest: m.manifest, entries: [...reader.entries()] };
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

    // 2. cross-check entries ↔ manifest before touching data
    const byPath = new Map(manifest.contents.map((c) => [c.path, c] as const));
    const entries = reader.entries();
    const entryNames = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      if (e.name === WORLDPACK_MANIFEST_PATH) continue;
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

    // 3. stream every content entry, verifying CRC-32 (zip) and SHA-256 (manifest)
    if (streams) {
      try {
        await streams.manifest(manifestBytes);
      } catch (err) {
        result.issues.push(errorText(err));
        return result;
      }
    }
    for (const e of entries) {
      if (e.name === WORLDPACK_MANIFEST_PATH) continue;
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
  for (const e of v.entries)
    lines.push(
      `     ✓ ${e.path.padEnd(32)} ${e.kind.padEnd(12)} ${String(e.sizeBytes).padStart(12)} B  sha256 ${e.sha256.slice(0, 16)}…`,
    );
  for (const w of v.warnings) lines.push(`     warning: ${w}`);
  for (const i of v.issues) lines.push(`     issue: ${i}`);
  return lines.join('\n');
}
