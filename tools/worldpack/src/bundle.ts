import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { verifyWorldPack, type TrustedPublisher } from '@worldview/offline';

/**
 * A field bundle: the set of `.worldpack` files for an area (the Oahu exemplar: a basemap pack,
 * a places pack, a history pack …) carried to the external SSD, with a manifest of their sizes
 * and SHA-256 so the copy can be checked on the drive before anything is installed from it.
 *
 *   pnpm worldpack bundle <dir>           verify every pack in <dir>, write worldview-bundle.json
 *                                         and SHA256SUMS.txt beside them
 *   pnpm worldpack bundle <dir> --check   re-hash every file against worldview-bundle.json
 *
 * Several regional packs rather than one large one: each stays inside the .worldpack limits
 * (zip32, 2 GiB per entry, 8 GiB declared — docs/OFFLINE-PACKS.md), and one can be replaced
 * without the others.
 */

export const BUNDLE_MANIFEST = 'worldview-bundle.json';
export const BUNDLE_SUMS = 'SHA256SUMS.txt';

export interface BundleEntry {
  file: string;
  sizeBytes: number;
  sha256: string;
  id: string;
  name: string;
  version: string;
  createdAt: string;
  bounds: { west: number; south: number; east: number; north: number };
  /** unsigned, signed (key not among the given publishers), trusted, unchecked */
  signature: string;
}

export interface BundleManifest {
  formatVersion: 1;
  createdAt: string;
  packs: BundleEntry[];
  totalBytes: number;
}

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function packFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.worldpack'))
    .map((e) => e.name)
    .sort();
}

/**
 * Verify every pack in `dir` (structure, hashes, signature) and describe them. Refuses the whole
 * bundle when any pack fails verification or two packs share an id: a bundle is meant to install
 * cleanly, all of it.
 */
export async function makeBundle(
  dir: string,
  opts: { now?: () => number; trustedPublishers?: readonly TrustedPublisher[] } = {},
): Promise<{ ok: true; manifest: BundleManifest } | { ok: false; issues: string[] }> {
  const files = await packFiles(dir);
  if (files.length === 0) return { ok: false, issues: [`no .worldpack files in ${dir}`] };
  const issues: string[] = [];
  const packs: BundleEntry[] = [];
  const ids = new Map<string, string>();
  for (const file of files) {
    const abs = path.join(dir, file);
    const v = await verifyWorldPack(abs, {
      ...(opts.trustedPublishers ? { trustedPublishers: opts.trustedPublishers } : {}),
    });
    if (!v.ok || !v.manifest) {
      issues.push(`${file}: ${v.issues.slice(0, 3).join('; ') || 'not a valid pack'}`);
      continue;
    }
    const m = v.manifest;
    const other = ids.get(m.id);
    if (other) issues.push(`${file} and ${other} are both the pack "${m.id}"`);
    ids.set(m.id, file);
    const sig = v.signature;
    packs.push({
      file,
      sizeBytes: v.sizeBytes,
      sha256: await sha256OfFile(abs),
      id: m.id,
      name: m.name,
      version: m.version ?? m.createdAt.slice(0, 10),
      createdAt: m.createdAt,
      bounds: m.geographicBounds,
      signature: !sig ? 'unchecked' : sig.status === 'signed' ? (sig.trusted ? 'trusted' : 'signed') : sig.status,
    });
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    manifest: {
      formatVersion: 1,
      createdAt: new Date((opts.now ?? Date.now)()).toISOString(),
      packs,
      totalBytes: packs.reduce((n, p) => n + p.sizeBytes, 0),
    },
  };
}

export function sumsText(manifest: BundleManifest): string {
  return manifest.packs.map((p) => `${p.sha256}  ${p.file}\n`).join('');
}

export async function writeBundle(dir: string, manifest: BundleManifest): Promise<void> {
  await fs.writeFile(path.join(dir, BUNDLE_MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(dir, BUNDLE_SUMS), sumsText(manifest));
}

/** Check a copied bundle: every listed file present, the right size and hash, nothing extra unlisted. */
export async function checkBundle(dir: string): Promise<{ ok: boolean; problems: string[]; checked: number }> {
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, BUNDLE_MANIFEST), 'utf8')) as BundleManifest;
    if (manifest.formatVersion !== 1 || !Array.isArray(manifest.packs)) throw new Error('not a bundle manifest');
  } catch (err) {
    return {
      ok: false,
      problems: [`${BUNDLE_MANIFEST}: ${err instanceof Error ? err.message : String(err)}`],
      checked: 0,
    };
  }
  const problems: string[] = [];
  let checked = 0;
  for (const p of manifest.packs) {
    // The manifest is data from a drive: a name that leaves the folder is refused, not followed.
    if (path.basename(p.file) !== p.file || !p.file.endsWith('.worldpack')) {
      problems.push(`${p.file}: not a pack file name`);
      continue;
    }
    const abs = path.join(dir, p.file);
    try {
      const st = await fs.stat(abs);
      if (st.size !== p.sizeBytes) {
        problems.push(`${p.file}: ${st.size} bytes, the manifest says ${p.sizeBytes}`);
        continue;
      }
      if ((await sha256OfFile(abs)) !== p.sha256) {
        problems.push(`${p.file}: SHA-256 differs from the manifest (a damaged copy?)`);
        continue;
      }
      checked++;
    } catch {
      problems.push(`${p.file}: missing`);
    }
  }
  const listed = new Set(manifest.packs.map((p) => p.file));
  for (const f of await packFiles(dir)) if (!listed.has(f)) problems.push(`${f}: not in the manifest`);
  return { ok: problems.length === 0, problems, checked };
}
