/**
 * `pnpm provider:scaffold` — a new provider for a GeoJSON feed of points, complete and
 * passing the contract checklist from its first commit (roadmap 0.6).
 *
 * What it writes is a working provider, not a sketch: it polls one https GeoJSON
 * FeatureCollection, admits Point features with valid coordinates and a usable id, keeps
 * their plain properties (bounded), dates each by a time property when the feed has one,
 * and reports what it refused. Its fixtures are generated to match, so the 16-check
 * contract run passes as generated, and the licence record it adds is the most
 * conservative there is — manual review, off by default, no raw payloads, no
 * redistribution, no export, no offline packs — until someone reads the source's terms
 * and changes both the record and the manifest (directive §6–8: a source's licence is
 * decided by a person, never by a template).
 *
 * The provider is not registered in the runtime: that is one line in providers/registry,
 * made once the licence record is settled. The CLI says so.
 */

export const SCAFFOLD_OBJECT_TYPES = [
  'aircraft',
  'vessel',
  'earthquake',
  'fire-detection',
  'storm',
  'weather-station',
  'weather-alert',
  'camera',
  'transit-vehicle',
  'infrastructure',
  'airport',
  'port',
  'place',
  'launch',
  'sensor',
  'imagery-scene',
] as const;
export type ScaffoldObjectType = (typeof SCAFFOLD_OBJECT_TYPES)[number];

/** Lens categories for each object type (manifest.categories). */
const CATEGORIES: Record<ScaffoldObjectType, string[]> = {
  aircraft: ['aviation'],
  vessel: ['maritime'],
  earthquake: ['earth', 'disasters'],
  'fire-detection': ['fire', 'disasters'],
  storm: ['weather', 'disasters'],
  'weather-station': ['weather'],
  'weather-alert': ['weather', 'disasters'],
  camera: ['cameras'],
  'transit-vehicle': ['transit'],
  infrastructure: ['infrastructure'],
  airport: ['aviation', 'infrastructure'],
  port: ['maritime', 'infrastructure'],
  place: ['earth'],
  launch: ['space'],
  sensor: ['environment'],
  'imagery-scene': ['space', 'earth'],
};

export interface ScaffoldOptions {
  /** Directory under providers/ and the provider id (kebab-case). */
  id: string;
  /** Display name, e.g. "Example City sensors". */
  name: string;
  objectType: ScaffoldObjectType;
  /** The https GeoJSON FeatureCollection to poll. */
  url: string;
  /** The licence as the source states it, e.g. "CC BY 4.0" — recorded, not interpreted. */
  licence: string;
  /** Attribution text shown with the data. */
  attribution: string;
  /** Feature property holding a stable id (default: the feature's own `id`). */
  idProperty?: string;
  /** Feature property holding the observation time (ISO 8601 or epoch ms), when the feed has one. */
  timeProperty?: string;
  /** Poll interval in seconds (default 300, at least 60). */
  intervalSeconds?: number;
}

export interface ScaffoldResult {
  /** Repository-relative path → file content. */
  files: Record<string, string>;
  /** The record to append to config/licenses/providers.json. */
  record: Record<string, unknown>;
  /** What is left for a person to do, in order. */
  nextSteps: string[];
}

const ID = /^[a-z][a-z0-9-]{1,40}[a-z0-9]$/;
const PROPERTY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** Why the options cannot be scaffolded, or undefined when they can. */
export function checkOptions(o: ScaffoldOptions): string | undefined {
  if (!ID.test(o.id)) return 'id must be kebab-case, 3–42 characters (e.g. "example-sensors")';
  if (o.id === 'registry') return 'id "registry" is taken by the provider registry';
  // eslint-disable-next-line no-control-regex
  if ([o.name, o.licence, o.attribution].some((t) => /[\u0000-\u001f\u007f]/.test(t)))
    return 'name, licence and attribution must be plain text on one line';
  if (!o.name.trim() || o.name.length > 80) return 'name must be 1–80 characters';
  if (!(SCAFFOLD_OBJECT_TYPES as readonly string[]).includes(o.objectType))
    return `object type must be one of ${SCAFFOLD_OBJECT_TYPES.join(', ')}`;
  let url: URL;
  try {
    url = new URL(o.url);
  } catch {
    return 'url is not a URL';
  }
  if (url.protocol !== 'https:') return 'url must be https';
  if (url.username || url.password) return 'url must not carry a login';
  if (!o.licence.trim() || o.licence.length > 200) return 'licence must be 1–200 characters';
  if (!o.attribution.trim() || o.attribution.length > 300) return 'attribution must be 1–300 characters';
  if (o.idProperty !== undefined && !PROPERTY.test(o.idProperty)) return 'idProperty is not a property name';
  if (o.timeProperty !== undefined && !PROPERTY.test(o.timeProperty)) return 'timeProperty is not a property name';
  if (o.intervalSeconds !== undefined && (!Number.isInteger(o.intervalSeconds) || o.intervalSeconds < 60))
    return 'intervalSeconds must be a whole number of at least 60';
  return undefined;
}

/**
 * A string literal as Prettier writes it: single quotes, unless the text holds more single
 * quotes than double, when double quotes need fewer escapes.
 */
function q(s: string): string {
  const singles = (s.match(/'/g) ?? []).length;
  const doubles = (s.match(/"/g) ?? []).length;
  const quote = singles > doubles ? '"' : "'";
  return `${quote}${s.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`)}${quote}`;
}

/** Text safe inside a block comment. */
const c = (s: string) => s.replace(/\*\//g, '*\\/');

/** An object key as Prettier writes it: bare when it is an identifier. */
const key = (s: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : q(s));

const WIDTH = 120;

/**
 * `head value,` on one line when it fits the repository's 120-column Prettier width, else
 * broken after `head` the way Prettier breaks it — so a generated file is formatted as
 * written and \`pnpm format:check\` passes without a --write.
 */
function fit(indent: string, head: string, value: string, tail = ','): string {
  const one = `${indent}${head} ${value}${tail}`;
  // Prettier never breaks after a short object key (up to four characters: `name:`, `text:`).
  const shortKey = head.endsWith(':') && head.length <= 5;
  return one.length <= WIDTH || shortKey ? one : `${indent}${head}\n${indent}  ${value}${tail}`;
}

/** `import { a, b } from 'x';` on one line when it fits, else one name per line. */
function named(keyword: 'import' | 'export', names: string[], from: string): string {
  const one = `${keyword} { ${names.join(', ')} } from '${from}';`;
  return one.length <= WIDTH ? one : `${keyword} {\n${names.map((n) => `  ${n},\n`).join('')}} from '${from}';`;
}

function pascal(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function constant(id: string): string {
  return id.replace(/-/g, '_').toUpperCase();
}

export function scaffoldProvider(o: ScaffoldOptions): ScaffoldResult {
  const problem = checkOptions(o);
  if (problem) throw new Error(problem);
  const host = new URL(o.url).hostname;
  const P = pascal(o.id);
  const C = constant(o.id);
  const interval = o.intervalSeconds ?? 300;
  const idProp = o.idProperty;
  const timeProp = o.timeProperty;
  const base = `providers/${o.id}`;
  const fixtures = `fixtures/${o.id}`;
  const files: Record<string, string> = {};

  files[`${base}/package.json`] = `${JSON.stringify(
    {
      name: `@worldview/provider-${o.id}`,
      version: '0.1.0',
      private: true,
      description: `${o.name} (scaffolded GeoJSON point feed). Licence as stated by the source: ${o.licence}.`,
      license: 'MIT',
      type: 'module',
      main: './src/index.ts',
      types: './src/index.ts',
      exports: { '.': './src/index.ts' },
      scripts: { typecheck: 'tsc -p tsconfig.json' },
      dependencies: { '@worldview/world-model': 'workspace:*', '@worldview/provider-sdk': 'workspace:*' },
      sideEffects: false,
    },
    null,
    2,
  )}\n`;

  files[`${base}/tsconfig.json`] = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
`;

  files[`${base}/src/manifest.ts`] = `import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * ${c(o.name)} — scaffolded by \`pnpm provider:scaffold\` for a GeoJSON feed of points.
 * Source: ${c(o.url)}
 * Licence as stated by the source: ${c(o.licence)}
 *
 * The data policy below is the most conservative one: nothing is decided about this source's
 * terms until a person has read them. When they have, change this policy and the record in
 * config/licenses/providers.json together — the licence audit and the contract checklist
 * both hold the two equal.
 */
${fit('', `export const ${C}_URL =`, q(o.url), ';')}

export const ${C}_MANIFEST: ProviderManifest = {
  id: ${q(o.id)},
${fit('  ', 'name:', q(o.name))}
  version: '0.1.0',
${fit('  ', 'description:', q(`${o.name}: points from ${host}.`))}
  objectTypes: [${q(o.objectType)}],
  categories: [${CATEGORIES[o.objectType].map(q).join(', ')}],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: ${interval * 1000},
    minIntervalMs: 60_000,
    timeoutMs: 20_000,
    maxRetries: 2,
    maxRequestsPerMinute: 4,
    staleWhileErrorMs: 3600_000,
    freshness: { ${key(o.objectType)}: { liveSeconds: ${Math.max(interval * 3, 900)}, recentSeconds: ${Math.max(interval * 24, 6 * 3600)} } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: true,
    maxRetentionSeconds: 86400,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: false,
    commercialUseAllowed: 'unknown',
    attributionRequired: true,
${fit('    ', 'attributionText:', q(o.attribution))}
  },
  attribution: {
${fit('    ', 'text:', q(o.attribution))}
${fit('    ', 'url:', q(`https://${host}/`))}
  },
  commercialReview: 'manual-review-required',
  enabledByDefault: false,
  allowedHosts: [${q(host)}],
};
`;

  const rawId = idProp ? `props[${q(idProp)}]` : 'f.id';
  const timeBlock = timeProp
    ? `  const t = props[${q(timeProp)}];
  const ms = typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : Number.NaN;
  // A time from the feed dates the observation; one in the future (beyond clock skew) is refused.
  if (Number.isFinite(ms) && ms <= opts.nowMs + 5 * 60_000) return new Date(ms).toISOString();
  return undefined;`
    : `  // The feed carries no time property: an observation is dated when it was fetched.
  return opts.receivedAt;`;

  files[`${base}/src/normalize.ts`] =
    `import { isValidLatLon, type JsonValue, type Observation } from '@worldview/world-model';
import { buildObservation, type ObservationDraft } from '@worldview/provider-sdk';
import { ${C}_MANIFEST } from './manifest.js';

/**
 * GeoJSON FeatureCollection of points → observations. A feature is admitted with valid
 * coordinates and an id of letters, digits and \`._:-\`; anything else is refused with a
 * reason, never guessed. Its plain properties are kept — strings up to 300 characters,
 * finite numbers, booleans; at most 40 — and nothing nested.
 */
export interface NormalizeOptions {
  receivedAt: string;
  nowMs: number;
  origin?: 'live' | 'cached';
  sourceRef?: string;
}

export interface NormalizeResult {
  observations: Observation[];
  total: number;
  rejected: Array<{ index: number; reason: string }>;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_PROPERTIES = 40;

export function normalizeFeed(payload: unknown, opts: NormalizeOptions): NormalizeResult {
  const fc = payload as { type?: unknown; features?: unknown } | null;
  if (!fc || typeof fc !== 'object' || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features))
    return { observations: [], total: 0, rejected: [{ index: -1, reason: 'not a GeoJSON FeatureCollection' }] };
  const observations: Observation[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  fc.features.forEach((raw, index) => {
    const draft = toDraft(raw, opts);
    if (typeof draft === 'string') {
      rejected.push({ index, reason: draft });
      return;
    }
    if (seen.has(draft.externalId)) {
      rejected.push({ index, reason: \`duplicate id \${draft.externalId}\` });
      return;
    }
    seen.add(draft.externalId);
    observations.push(buildObservation(${C}_MANIFEST, opts.receivedAt, draft));
  });
  return { observations, total: fc.features.length, rejected };
}

function toDraft(raw: unknown, opts: NormalizeOptions): ObservationDraft | string {
  const f = raw as { id?: unknown; geometry?: { type?: unknown; coordinates?: unknown } | null; properties?: unknown };
  if (!f || typeof f !== 'object') return 'not a feature';
  if (f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) return 'not a point';
  const [lon, lat] = f.geometry.coordinates as unknown[];
  if (!isValidLatLon(lat, lon)) return 'invalid coordinates';
  const props = (f.properties && typeof f.properties === 'object' ? f.properties : {}) as Record<string, unknown>;
  const rawId = ${rawId};
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '';
  if (!ID.test(id)) return 'missing or invalid id';
  const observedAt = observedAtOf(props, opts);
  if (!observedAt) return 'invalid or future time';
  const payload: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(props)) {
    if (Object.keys(payload).length >= MAX_PROPERTIES) break;
    if (!KEY.test(k)) continue;
    if (typeof v === 'string') payload[k] = v.slice(0, 300);
    else if (typeof v === 'number' && Number.isFinite(v)) payload[k] = v;
    else if (typeof v === 'boolean') payload[k] = v;
  }
  const draft: ObservationDraft = {
    externalId: id,
    objectType: ${q(o.objectType)},
    observedAt,
    position: { latitude: lat as number, longitude: lon as number },
    payload,
    quality: { complete: true, sourceQuality: 'unknown' },
    origin: opts.origin ?? 'live',
  };
  if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
  return draft;
}

function observedAtOf(props: Record<string, unknown>, opts: NormalizeOptions): string | undefined {
${timeBlock}
}
`;

  files[`${base}/src/index.ts`] = `import type { Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
${named('import', [`${C}_MANIFEST`, `${C}_URL`], './manifest.js')}
import { normalizeFeed } from './normalize.js';

${named('export', [`${C}_MANIFEST`, `${C}_URL`], './manifest.js')}
export { normalizeFeed } from './normalize.js';

const MAX_BYTES = 8 * 1024 * 1024;
${fit('', 'const LABEL =', q(o.name), ';')}

/** ${c(o.name)}: one GeoJSON request per poll, normalized; refused rows are logged with reasons. */
export class ${P}Provider extends PollingProvider {
  readonly manifest: ProviderManifest = ${C}_MANIFEST;

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    const res = await this.context.http.request({
      url: ${C}_URL,
      signal: request.signal,
      maxBytes: MAX_BYTES,
      headers: { Accept: 'application/geo+json, application/json' },
    });
    let payload: unknown;
    try {
      payload = res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', \`\${LABEL}: response is not JSON\`, { retryable: false });
    }
    const nowMs = this.context.clock.now();
    const result = normalizeFeed(payload, {
      receivedAt: new Date(nowMs).toISOString(),
      nowMs,
      origin: res.stale || res.fromCache ? 'cached' : 'live',
      sourceRef: ${C}_URL,
    });
    if (result.rejected.some((r) => r.index === -1)) {
      res.invalidate();
      throw new ProviderError('MALFORMED', \`\${LABEL}: not a GeoJSON FeatureCollection\`, { retryable: false });
    }
    if (result.total > 0 && result.observations.length === 0) {
      res.invalidate();
      assertAtomicAdmission(result.total, 0, LABEL);
    }
    if (result.rejected.length)
      this.context.logger.warn('rejected rows', {
        count: result.rejected.length,
        sample: result.rejected.slice(0, 3).map((r) => r.reason),
      });
    return { observations: result.observations, cacheAgeMs: res.ageMs };
  }
}

export function createProvider(): ${P}Provider {
  return new ${P}Provider();
}
`;

  // ---- fixtures: generated to match the normalizer, so the checklist passes as written ----
  const feature = (id: string, lon: number, lat: number, when?: string, extra: Record<string, unknown> = {}) => {
    const properties: Record<string, unknown> = { name: `Sample ${id}`, ...extra };
    if (idProp) properties[idProp] = id;
    if (timeProp && when) properties[timeProp] = when;
    return {
      type: 'Feature',
      ...(idProp ? {} : { id }),
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties,
    };
  };
  const fc = (features: unknown[]) => `${JSON.stringify({ type: 'FeatureCollection', features }, null, 2)}\n`;
  const t = (iso: string) => (timeProp ? iso : undefined);
  files[`${fixtures}/normal.geojson`] = fc([
    feature('a1', -157.86, 21.31, t('2026-09-21T08:00:00.000Z'), { value: 12.5 }),
    feature('a2', 2.35, 48.86, t('2026-09-21T07:59:00.000Z'), { value: 7, active: true }),
    feature('a3', 151.21, -33.87, t('2026-09-21T07:58:00.000Z')),
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [500, 0] },
      properties: idProp ? { [idProp]: 'bad' } : {},
    },
  ]);
  files[`${fixtures}/empty.geojson`] = fc([]);
  if (timeProp)
    files[`${fixtures}/stale.geojson`] = fc([
      feature('a1', -157.86, 21.31, '2026-09-19T08:00:00.000Z'),
      feature('a2', 2.35, 48.86, '2026-09-19T07:00:00.000Z'),
    ]);
  files[`${fixtures}/malformed-rows.geojson`] = fc([
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      properties: {},
    },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 95] }, properties: {} },
  ]);
  files[`${fixtures}/malformed-shape.json`] = `${JSON.stringify({ items: [] })}\n`;
  files[`${fixtures}/malformed-notjson.txt`] = 'service unavailable\n';
  files[`${fixtures}/README.md`] = `# ${o.name} fixtures

Synthetic **contract fixtures**, generated by \`pnpm provider:scaffold\` to match the scaffolded
normalizer — not recorded from ${host}. They exist so the contract checklist runs without the
network; replace them with a recorded response (\`pnpm provider:record\`) before the provider is
registered.

- \`normal.geojson\` — three valid points and one with out-of-range coordinates
- \`empty.geojson\` — a valid collection with no features${
    timeProp ? `\n- \`stale.geojson\` — two points dated two days before the checklist's clock` : ''
  }
- \`malformed-rows.geojson\` — a line string and a point with latitude 95: none admitted
- \`malformed-shape.json\` — valid JSON, not a FeatureCollection
- \`malformed-notjson.txt\` — a plain-text error body

Reference time: 2026-09-21T08:00:00Z.
`;

  files[`${base}/test/contract/plan.ts`] = `import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlan } from '@worldview/tool-provider-validator';
import { createProvider } from '../../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const fixtures = path.join(root, 'fixtures', ${q(o.id)});
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

export const plan = definePlan({
  providerDir: ${q(o.id)},
  create: () => createProvider(),
  fixtures: {
    normal: () => ({ status: 200, body: body('normal.geojson'), headers: { 'content-type': 'application/geo+json' } }),
    empty: () => ({ status: 200, body: body('empty.geojson') }),${
      timeProp ? `\n    stale: () => ({ status: 200, body: body('stale.geojson') }),` : ''
    }
    malformed: [
      () => ({ status: 200, body: body('malformed-rows.geojson') }),
      () => ({ status: 200, body: body('malformed-shape.json') }),
      () => ({ status: 200, body: body('malformed-notjson.txt') }),
      () => ({ status: 200, body: '' }),
    ],
  },
  expectations: {
    objectTypes: [${q(o.objectType)}],
    minObservations: 3,
    verify: (obs) => {
      if (obs.length !== 3) return \`expected 3 observations, got \${obs.length}\`;
      if (obs.some((o) => o.rawPayloadHash)) return 'raw payload hash kept although raw retention is not allowed';
      return undefined;
    },
  },
});
`;

  files[`${base}/test/contract/${o.id}.contract.test.ts`] = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProviderChecklist, formatReport } from '@worldview/tool-provider-validator';
import { plan } from './plan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test(${q(`${o.id} provider passes the full contract checklist`)}, async () => {
  const report = await runProviderChecklist(plan, { repoRoot: root });
  const failed = report.checks.filter((c) => c.status === 'FAIL');
  assert.equal(failed.length, 0, \`\\n\${formatReport(report)}\`);
});
`;

  const record = {
    providerId: o.id,
    name: o.name,
    sourceUrl: o.url,
    termsUrl: `https://${host}/`,
    license: `${o.licence} (as stated by the source; not yet reviewed)`,
    category: o.objectType,
    plannedStatus: 'optional',
    dataPolicy: {
      cacheAllowed: true,
      rawPayloadRetentionAllowed: false,
      normalizedRetentionAllowed: true,
      maxRetentionSeconds: 86400,
      redistributionAllowed: false,
      offlinePackAllowed: false,
      exportAllowed: false,
      commercialUseAllowed: 'unknown',
      attributionRequired: true,
      attributionText: o.attribution,
    },
    commercialReview: 'manual-review-required',
    notes:
      "Scaffolded by pnpm provider:scaffold. The most conservative policy until the source's terms are read; change it here and in the manifest together.",
  };

  return {
    files,
    record,
    nextSteps: [
      `Read the terms at https://${host}/ and set the policy in config/licenses/providers.json and providers/${o.id}/src/manifest.ts together.`,
      `Replace fixtures/${o.id}/*.geojson with a recorded response (pnpm provider:record) and adjust the plan's expectations.`,
      `Run: pnpm install && node tools/dev/run-tests.mjs --filter ${o.id}`,
      `Once the licence record is settled, map @worldview/provider-${o.id} in tsconfig.base.json and add it to providers/registry; until then it is never loaded.`,
    ],
  };
}
