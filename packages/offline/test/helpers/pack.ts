import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type {
  WorldPackContent,
  WorldPackContentKind,
  WorldPackManifest,
  WorldPackSourcePolicy,
} from '../../src/manifest.js';
import { PlaceIndex, type PlaceEntry } from '../../src/place-index.js';
import { signManifest } from '../../src/signature.js';
import { rawZip, type RawEntry } from './raw-zip.js';

/** Test-only pack assembler over rawZip: a valid manifest by default, with hooks to break things. */
export interface TestPackFile {
  path: string;
  kind: WorldPackContentKind;
  data: Buffer;
  providerId?: string;
  objectType?: string;
  rowCount?: number;
  /** Raw-entry overrides (lying sizes, flags, attributes). */
  raw?: Partial<RawEntry>;
}

export interface TestPackOptions {
  id?: string;
  name?: string;
  files?: TestPackFile[];
  sourcePolicies?: WorldPackSourcePolicy[];
  minimumAppVersion?: string;
  expiresAt?: string;
  createdAt?: string;
  /** Mutate the manifest object before it is serialized (tampering). */
  mutateManifest?: (m: WorldPackManifest) => unknown;
  /** Extra raw entries not listed in the manifest. */
  extraEntries?: RawEntry[];
  /** Omit manifest.json from the archive. */
  omitManifest?: boolean;
  /** Leave out these paths from the archive although the manifest lists them. */
  omitEntries?: string[];
  /** Sign the serialized manifest with this Ed25519 private key (PEM): adds manifest.sig. */
  signWith?: string;
  /** A manifest.sig to ship as given (forged, stale or malformed signatures). */
  signature?: Buffer;
}

export const TEST_POLICY: WorldPackSourcePolicy = {
  providerId: 'worldview-seed-places',
  license: 'MIT',
  attribution: 'Seed places: WORLDVIEW project (MIT)',
  offlinePackAllowed: true,
  redistributionAllowed: true,
};

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const HAWAII_ENTRIES: PlaceEntry[] = [
  {
    id: 'place:city:honolulu-hi',
    name: 'Honolulu',
    altNames: [],
    kind: 'city',
    countryCode: 'US',
    position: { latitude: 21.31, longitude: -157.86 },
    importance: 0.85,
  },
  {
    id: 'airport:PHNL',
    name: 'Daniel K. Inouye International Airport',
    altNames: ['Honolulu Airport'],
    kind: 'airport',
    iata: 'HNL',
    icao: 'PHNL',
    countryCode: 'US',
    position: { latitude: 21.32, longitude: -157.92 },
    importance: 0.5,
  },
  {
    id: 'place:region:oahu-hi',
    name: 'Oʻahu',
    altNames: ['Oahu'],
    kind: 'region',
    countryCode: 'US',
    position: { latitude: 21.48, longitude: -157.98 },
    importance: 0.8,
  },
];

export function defaultFiles(): TestPackFile[] {
  const places = Buffer.from(
    JSON.stringify({
      type: 'FeatureCollection',
      features: HAWAII_ENTRIES.map((e) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.position.longitude, e.position.latitude] },
        properties: { id: e.id, name: e.name, altNames: e.altNames, kind: e.kind, importance: e.importance },
      })),
    }),
  );
  const index = Buffer.from(JSON.stringify(new PlaceIndex(HAWAII_ENTRIES).toJSON()));
  return [
    {
      path: 'data/places.geojson',
      kind: 'geojson',
      data: places,
      providerId: 'worldview-seed-places',
      objectType: 'place',
      rowCount: HAWAII_ENTRIES.length,
    },
    { path: 'search/index.json', kind: 'search-index', data: index, rowCount: HAWAII_ENTRIES.length },
  ];
}

export function buildTestPack(opts: TestPackOptions = {}): { bytes: Buffer; manifest: WorldPackManifest } {
  const files = opts.files ?? defaultFiles();
  if (!files.some((f) => f.kind === 'notices'))
    files.push({
      path: 'licenses/NOTICES.md',
      kind: 'notices',
      data: Buffer.from('# Data notices\n\nSeed places: WORLDVIEW project (MIT)\n'),
    });
  const contents: WorldPackContent[] = files.map((f) => ({
    path: f.path,
    kind: f.kind,
    sizeBytes: f.data.length,
    sha256: sha256(f.data),
    ...(f.providerId !== undefined ? { providerId: f.providerId } : {}),
    ...(f.objectType !== undefined ? { objectType: f.objectType } : {}),
    ...(f.rowCount !== undefined ? { rowCount: f.rowCount } : {}),
  }));
  const manifest: WorldPackManifest = {
    formatVersion: 1,
    id: opts.id ?? 'hawaii-test',
    name: opts.name ?? 'Hawaii test pack',
    createdAt: opts.createdAt ?? '2026-09-21T10:00:00.000Z',
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    geographicBounds: { west: -161, south: 18.5, east: -154.5, north: 22.5 },
    contents,
    sourcePolicies:
      opts.sourcePolicies ??
      (contents.some((c) => c.providerId === TEST_POLICY.providerId) ? [{ ...TEST_POLICY }] : []),
    minimumAppVersion: opts.minimumAppVersion ?? '0.1.0',
    checksums: Object.fromEntries(contents.map((c) => [c.path, c.sha256])),
  };
  const serialized = opts.mutateManifest ? (opts.mutateManifest(manifest) ?? manifest) : manifest;
  const entries: RawEntry[] = files
    .filter((f) => !(opts.omitEntries ?? []).includes(f.path))
    .map((f) => ({ name: f.path, data: f.data, ...f.raw }));
  const manifestBytes = Buffer.from(JSON.stringify(serialized));
  if (!opts.omitManifest) entries.push({ name: 'manifest.json', data: manifestBytes });
  if (opts.signWith)
    entries.push({ name: 'manifest.sig', data: Buffer.from(signManifest(manifestBytes, opts.signWith)) });
  else if (opts.signature) entries.push({ name: 'manifest.sig', data: opts.signature });
  entries.push(...(opts.extraEntries ?? []));
  return { bytes: rawZip(entries), manifest };
}

export async function writeTestPack(file: string, opts: TestPackOptions = {}): Promise<WorldPackManifest> {
  const { bytes, manifest } = buildTestPack(opts);
  await fs.writeFile(file, bytes);
  return manifest;
}
