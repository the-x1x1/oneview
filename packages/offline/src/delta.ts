import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  WORLDPACK_MANIFEST_PATH,
  parseWorldPackManifest,
  type WorldPackContent,
  type WorldPackManifest,
} from './manifest.js';
import { WORLDPACK_SIGNATURE_PATH, keyIdOf, publicKeyOf, signManifest } from './signature.js';
import { errorText, extractWorldPack, readWorldPackManifest, verifyWorldPack } from './verify.js';
import { ZIP_METHOD_DEFLATE, ZIP_METHOD_STORE, ZipReader, ZipWriter, type ZipReaderLimits } from './zip.js';

/**
 * Update packs (`pnpm worldpack update --from old.worldpack --to new.worldpack`, roadmap 0.2
 * incremental pack updates).
 *
 * An update carries only the files that changed between two builds of the same pack. Its
 * manifest is the new build's, with `base` naming the pack it applies to — by the SHA-256 of
 * that pack's manifest.json — and `fromBase: true` on every file it takes from it unchanged.
 * Installing it copies those files out of the installed base, checks each against the new
 * manifest's SHA-256, and only then replaces the pack; an installed base that differs by a
 * byte refuses the update (install the full pack instead). A 2 GB basemap whose places layer
 * changed ships as a few hundred kilobytes.
 *
 * The new build must be a full pack (its changed files have to come from somewhere); the old
 * one needs only a readable manifest, so an update can follow an update. An app from before
 * update packs refuses one outright — its strict manifest schema does not know `base`.
 */
export interface UpdatePackResult {
  outputPath: string;
  sizeBytes: number;
  /** Files carried in the update. */
  carried: string[];
  /** Files taken from the installed base. */
  reused: string[];
  signedBy?: string;
}

export async function buildUpdatePack(opts: {
  from: string;
  to: string;
  outputPath: string;
  signingKeyPem?: string;
  limits?: ZipReaderLimits;
}): Promise<UpdatePackResult> {
  if (opts.signingKeyPem !== undefined) {
    try {
      publicKeyOf(opts.signingKeyPem);
    } catch (err) {
      throw new Error(`signing key unusable: ${errorText(err)}`);
    }
  }
  const limits = opts.limits ? { limits: opts.limits } : {};
  const base = await readWorldPackManifest(opts.from, opts.limits);
  if (!base.ok) throw new Error(`--from is not a readable pack: ${base.issues.slice(0, 2).join('; ')}`);
  const baseBytes = await readManifestBytes(opts.from, opts.limits);
  const next = await verifyWorldPack(opts.to, limits);
  if (!next.ok || !next.manifest) throw new Error(`--to does not verify: ${next.issues.slice(0, 3).join('; ')}`);
  const to = next.manifest;
  if (to.base) throw new Error('--to is itself an update pack; build the update from a full pack');
  if (to.id !== base.manifest.id) throw new Error(`the packs are different packs ("${base.manifest.id}", "${to.id}")`);
  if (Date.parse(to.createdAt) <= Date.parse(base.manifest.createdAt))
    throw new Error(`--to (created ${to.createdAt}) is not newer than --from (created ${base.manifest.createdAt})`);

  const baseByPath = new Map(base.manifest.contents.map((c) => [c.path, c] as const));
  const contents: WorldPackContent[] = to.contents.map((c) => {
    const old = baseByPath.get(c.path);
    const same = old && old.sha256 === c.sha256 && old.sizeBytes === c.sizeBytes;
    const { fromBase: _drop, ...rest } = c;
    return same ? { ...rest, fromBase: true as const } : rest;
  });
  const manifest: WorldPackManifest = {
    ...to,
    contents,
    base: { createdAt: base.manifest.createdAt, manifestSha256: createHash('sha256').update(baseBytes).digest('hex') },
  };
  const check = parseWorldPackManifest(JSON.parse(JSON.stringify(manifest)));
  if (!check.ok) throw new Error(`update manifest is invalid: ${check.issues.join('; ')}`);

  const carried = contents.filter((c) => !c.fromBase).map((c) => c.path);
  const reused = contents.filter((c) => c.fromBase).map((c) => c.path);
  const out = path.resolve(opts.outputPath);
  const work = `${out}.${process.pid}.update`;
  const partial = `${out}.${process.pid}.partial`;
  await fs.rm(work, { recursive: true, force: true });
  let writer: ZipWriter | undefined;
  try {
    const extracted = await extractWorldPack(opts.to, work, limits);
    if (!extracted.ok) throw new Error(`--to could not be read: ${extracted.issues.slice(0, 2).join('; ')}`);
    const reader = await ZipReader.open(opts.to, opts.limits);
    const methods = new Map(reader.entries().map((e) => [e.name, e.method] as const));
    await reader.close();
    writer = await ZipWriter.create(partial, { mtime: new Date(to.createdAt) });
    for (const p of carried)
      await writer.add({
        name: p,
        data: { file: path.join(work, ...p.split('/')) },
        method: methods.get(p) ?? ZIP_METHOD_DEFLATE,
      });
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    await writer.add({ name: WORLDPACK_MANIFEST_PATH, data: manifestBytes, method: ZIP_METHOD_DEFLATE });
    let signedBy: string | undefined;
    if (opts.signingKeyPem !== undefined) {
      await writer.add({
        name: WORLDPACK_SIGNATURE_PATH,
        data: signManifest(manifestBytes, opts.signingKeyPem),
        method: ZIP_METHOD_STORE,
      });
      signedBy = keyIdOf(Buffer.from(publicKeyOf(opts.signingKeyPem), 'base64'));
    }
    const finished = await writer.finish();
    writer = undefined;
    await fs.rename(partial, out);
    const verified = await verifyWorldPack(out, limits);
    if (!verified.ok) throw new Error(`update pack does not verify: ${verified.issues.join('; ')}`);
    return { outputPath: out, sizeBytes: finished.sizeBytes, carried, reused, ...(signedBy ? { signedBy } : {}) };
  } catch (err) {
    await writer?.abort().catch(() => undefined);
    await fs.rm(partial, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readManifestBytes(file: string, limits?: ZipReaderLimits): Promise<Buffer> {
  const reader = await ZipReader.open(file, limits);
  try {
    return await reader.readEntry(WORLDPACK_MANIFEST_PATH, { maxBytes: 4 * 1024 * 1024 });
  } finally {
    await reader.close();
  }
}
