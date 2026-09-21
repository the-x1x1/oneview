import { boundsSchema, isIsoTimestamp, isValidBounds, s, type GeoBounds, type IsoTimestamp, type Schema } from '@worldview/world-model';

/**
 * WorldPackManifest — `manifest.json` at the root of a `.worldpack` (ADR-007).
 *
 * A pack is data only. The manifest declares what is inside, where it applies,
 * which sources it came from (with the policy flags that allowed inclusion) and
 * a SHA-256 for every file. Everything in a pack is validated against this schema
 * before a single byte is extracted.
 */
export const WORLDPACK_FORMAT_VERSION = 1;
export const WORLDPACK_EXTENSION = '.worldpack';
export const WORLDPACK_MANIFEST_PATH = 'manifest.json';
export const WORLDPACK_NOTICES_PATH = 'licenses/NOTICES.md';
export const WORLDPACK_SEARCH_INDEX_PATH = 'search/index.json';

export type WorldPackContentKind = 'pmtiles' | 'geojson' | 'parquet' | 'ndjson' | 'search-index' | 'notices';

export interface WorldPackContent {
  /** Archive-relative path with forward slashes, e.g. `maps/hawaii.pmtiles`. */
  path: string;
  kind: WorldPackContentKind;
  /** Uncompressed size. */
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the uncompressed file. */
  sha256: string;
  providerId?: string;
  objectType?: string;
  rowCount?: number;
}

export interface WorldPackSourcePolicy {
  providerId: string;
  license: string;
  attribution: string;
  offlinePackAllowed: boolean;
  redistributionAllowed: boolean;
  termsUrl?: string;
}

export interface WorldPackManifest {
  formatVersion: typeof WORLDPACK_FORMAT_VERSION;
  /** Stable kebab-case id; also the install directory name. */
  id: string;
  name: string;
  /** Optional pack version (semver). The app shows createdAt when absent. */
  version?: string;
  createdAt: IsoTimestamp;
  expiresAt?: IsoTimestamp;
  geographicBounds: GeoBounds;
  contents: WorldPackContent[];
  sourcePolicies: WorldPackSourcePolicy[];
  /** Semver; the registry refuses packs that need a newer app. */
  minimumAppVersion: string;
  /** path → sha256, one entry per content path (redundant with contents on purpose: the checksum table is what verification reads). */
  checksums: Record<string, string>;
}

const KEBAB = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const iso = s.refine(s.string({ max: 40 }), (v) => (isIsoTimestamp(v) ? undefined : 'expected UTC ISO 8601 timestamp (…Z)'));

/**
 * Allowed archive paths per content kind. Anything else is refused by the schema,
 * so an archive can never smuggle a file the app would not know how to treat.
 */
export const CONTENT_PATH_RULES: Readonly<Record<WorldPackContentKind, RegExp>> = Object.freeze({
  pmtiles: /^maps\/[A-Za-z0-9._-]+\.pmtiles$/,
  geojson: /^data\/[A-Za-z0-9._-]+\.geojson$/,
  parquet: /^data\/[A-Za-z0-9._-]+\.parquet$/,
  ndjson: /^data\/[A-Za-z0-9._-]+\.ndjson$/,
  'search-index': /^search\/index\.json$/,
  notices: /^licenses\/NOTICES\.md$/,
});

export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export const contentSchema: Schema<WorldPackContent> = s.refine(
  s.object({
    path: s.string({ min: 1, max: 255 }),
    kind: s.enum(['pmtiles', 'geojson', 'parquet', 'ndjson', 'search-index', 'notices'] as const),
    sizeBytes: s.number({ min: 0, max: 0xffff_ffff, integer: true }),
    sha256: s.string({ pattern: SHA256 }),
    providerId: s.optional(s.string({ min: 2, max: 64, pattern: KEBAB })),
    objectType: s.optional(s.string({ min: 1, max: 64, pattern: /^[a-z0-9][a-z0-9-]*$/ })),
    rowCount: s.optional(s.number({ min: 0, integer: true })),
  }, { strict: true }),
  (c) => (CONTENT_PATH_RULES[c.kind].test(c.path) ? undefined : `path "${c.path}" is not allowed for kind ${c.kind}`),
) as Schema<WorldPackContent>;

export const sourcePolicySchema: Schema<WorldPackSourcePolicy> = s.refine(
  s.object({
    providerId: s.string({ min: 2, max: 64, pattern: KEBAB }),
    license: s.string({ min: 1, max: 500 }),
    attribution: s.string({ min: 1, max: 500 }),
    offlinePackAllowed: s.boolean(),
    redistributionAllowed: s.boolean(),
    termsUrl: s.optional(s.string({ max: 2048 })),
  }, { strict: true }),
  (p) => (p.offlinePackAllowed && p.redistributionAllowed ? undefined : `source ${p.providerId} is not allowed in a world pack (offlinePackAllowed && redistributionAllowed must both be true)`),
) as Schema<WorldPackSourcePolicy>;

export const worldPackManifestSchema: Schema<WorldPackManifest> = s.refine(
  s.object({
    formatVersion: s.literal(WORLDPACK_FORMAT_VERSION),
    id: s.string({ pattern: KEBAB }),
    name: s.string({ min: 1, max: 120 }),
    version: s.optional(s.string({ max: 32, pattern: SEMVER })),
    createdAt: iso,
    expiresAt: s.optional(iso),
    geographicBounds: boundsSchema,
    contents: s.array(contentSchema, { min: 1, max: 4096 }),
    sourcePolicies: s.array(sourcePolicySchema, { max: 256 }),
    minimumAppVersion: s.string({ max: 32, pattern: SEMVER }),
    checksums: s.record(s.string({ pattern: SHA256 }), { keyPattern: /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, max: 4096 }),
  }, { strict: true }),
  (m) => {
    if (!isValidBounds(m.geographicBounds)) return 'geographicBounds invalid';
    if (m.expiresAt && Date.parse(m.expiresAt) < Date.parse(m.createdAt)) return 'expiresAt before createdAt';
    const seen = new Set<string>();
    const policyIds = new Set(m.sourcePolicies.map((p) => p.providerId));
    if (policyIds.size !== m.sourcePolicies.length) return 'duplicate providerId in sourcePolicies';
    let notices = 0;
    for (const c of m.contents) {
      const lower = c.path.toLowerCase();
      if (seen.has(lower)) return `duplicate content path "${c.path}"`;
      seen.add(lower);
      if (c.path === WORLDPACK_MANIFEST_PATH) return 'manifest.json cannot list itself';
      if (m.checksums[c.path] !== c.sha256) return `checksums["${c.path}"] must equal contents sha256`;
      if (c.providerId !== undefined && !policyIds.has(c.providerId)) return `content "${c.path}" references providerId "${c.providerId}" without a sourcePolicies entry`;
      if (c.kind === 'notices') notices++;
    }
    for (const key of Object.keys(m.checksums)) if (!seen.has(key.toLowerCase())) return `checksums["${key}"] has no contents entry`;
    if (notices !== 1) return 'exactly one licenses/NOTICES.md entry is required';
    for (const p of m.sourcePolicies) if (!m.contents.some((c) => c.providerId === p.providerId)) return `sourcePolicies entry "${p.providerId}" is not used by any content`;
    return undefined;
  },
) as Schema<WorldPackManifest>;

export function parseWorldPackManifest(value: unknown): { ok: true; manifest: WorldPackManifest } | { ok: false; issues: string[] } {
  const r = worldPackManifestSchema.parse(value);
  if (r.ok) return { ok: true, manifest: r.value };
  return { ok: false, issues: r.issues.map((i) => `${i.path || '<root>'}: ${i.message}`) };
}

/** Compare two semver strings (numeric core only; pre-release sorts before release). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('-'), pb = b.split('-');
  const na = (pa[0] ?? '').split('.').map(Number), nb = (pb[0] ?? '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa[1] === undefined && pb[1] === undefined) return 0;
  if (pa[1] === undefined) return 1;
  if (pb[1] === undefined) return -1;
  return pa[1] < pb[1] ? -1 : pa[1] > pb[1] ? 1 : 0;
}

export function isSemver(v: string): boolean { return SEMVER.test(v); }
