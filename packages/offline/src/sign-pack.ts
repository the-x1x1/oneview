import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WORLDPACK_MANIFEST_PATH } from './manifest.js';
import { WORLDPACK_SIGNATURE_PATH, keyIdOf, publicKeyOf, signManifest } from './signature.js';
import { errorText, extractWorldPack, verifyWorldPack } from './verify.js';
import { ZIP_METHOD_DEFLATE, ZIP_METHOD_STORE, ZipReader, ZipWriter, type ZipReaderLimits } from './zip.js';

/**
 * Sign a pack that already exists (`pnpm worldpack sign`): a pack built on one machine, signed
 * on another that holds the key.
 *
 * The pack is verified in full first — a pack that fails any check, including a signature
 * that no longer matches, is refused rather than blessed. It is then rewritten entry by entry,
 * in the same order with the same compression, with manifest.json copied byte for byte (the
 * signature covers those bytes, so nothing is re-serialized) and a new manifest.sig after it.
 * An existing valid signature is replaced. The output is verified again before this returns.
 */
export interface SignPackResult {
  keyId: string;
  /** The input already carried a (valid) signature, now replaced. */
  replacedSignature: boolean;
  sizeBytes: number;
}

export async function signWorldPack(
  input: string,
  output: string,
  privateKeyPem: string,
  opts: { limits?: ZipReaderLimits } = {},
): Promise<SignPackResult> {
  let keyId: string;
  try {
    keyId = keyIdOf(Buffer.from(publicKeyOf(privateKeyPem), 'base64'));
  } catch (err) {
    throw new Error(`signing key unusable: ${errorText(err)}`);
  }
  const work = `${path.resolve(output)}.${process.pid}.signing`;
  const partial = `${path.resolve(output)}.${process.pid}.partial`;
  await fs.rm(work, { recursive: true, force: true });
  const extracted = await extractWorldPack(input, work, opts.limits ? { limits: opts.limits } : {});
  if (!extracted.ok || !extracted.manifest) {
    await fs.rm(work, { recursive: true, force: true });
    throw new Error(`pack not signed — it does not verify: ${extracted.issues.slice(0, 3).join('; ')}`);
  }
  const replacedSignature = extracted.signature?.status !== 'unsigned';
  let writer: ZipWriter | undefined;
  try {
    const reader = await ZipReader.open(input, opts.limits);
    const order = reader.entries().map((e) => ({ name: e.name, method: e.method }));
    await reader.close();
    writer = await ZipWriter.create(partial, { mtime: new Date(extracted.manifest.createdAt) });
    for (const e of order) {
      if (e.name === WORLDPACK_MANIFEST_PATH || e.name === WORLDPACK_SIGNATURE_PATH) continue;
      await writer.add({ name: e.name, data: { file: path.join(work, ...e.name.split('/')) }, method: e.method });
    }
    const manifestBytes = await fs.readFile(path.join(work, WORLDPACK_MANIFEST_PATH));
    await writer.add({ name: WORLDPACK_MANIFEST_PATH, data: manifestBytes, method: ZIP_METHOD_DEFLATE });
    await writer.add({
      name: WORLDPACK_SIGNATURE_PATH,
      data: signManifest(manifestBytes, privateKeyPem),
      method: ZIP_METHOD_STORE,
    });
    const finished = await writer.finish();
    writer = undefined;
    await fs.rename(partial, output);
    const check = await verifyWorldPack(output, opts.limits ? { limits: opts.limits } : {});
    if (!check.ok || check.signature?.status !== 'signed')
      throw new Error(`signed pack does not verify: ${check.issues.join('; ') || check.signature?.status}`);
    return { keyId, replacedSignature, sizeBytes: finished.sizeBytes };
  } catch (err) {
    await writer?.abort().catch(() => undefined);
    await fs.rm(partial, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
