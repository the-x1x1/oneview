import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * License audit (directive §6–8, §115). Fails closed on any of:
 *
 *  - a provider whose manifest has no record in config/licenses/providers.json;
 *  - a manifest whose dataPolicy / commercialReview diverges from that record;
 *  - a shipped connector definition (connectors/enabled/*.json, ADR-013) that is not
 *    reviewed, has no record, or whose resolved policy diverges from it;
 *  - a provider enabled by default whose record is excluded or manual-review-required;
 *  - a bundled software record with an unknown/missing license;
 *  - a bundled asset whose provenance decision is "exclude" or "review";
 *  - a data source that requires attribution without attribution text.
 *
 * The audit reads the manifests as source text rather than importing them, so it runs
 * without a build step and cannot be fooled by runtime mutation.
 */
export interface AuditFinding {
  severity: 'error' | 'warning';
  scope: 'provider' | 'software' | 'asset';
  subject: string;
  message: string;
}

export interface AuditReport {
  ranAt: string;
  providers: { manifests: number; definitions: number; records: number; matched: number };
  software: { records: number; bundled: number; conditional: number };
  assets: {
    records: number;
    bundled: number;
    imported: number;
    clearedNotImported: number;
    excluded: number;
    review: number;
  };
  findings: AuditFinding[];
  passed: boolean;
}

interface ProviderRecord {
  providerId: string;
  name?: string;
  license?: string;
  plannedStatus?: string;
  commercialReview?: string;
  dataPolicy?: Record<string, unknown>;
}

interface SoftwareRecord {
  name: string;
  license?: string;
  integration?: string;
  distribution?: string;
  commercialReview?: string;
}

interface AssetRecord {
  path: string;
  license?: string;
  decision?: string;
  attribution?: string;
}

const POLICY_KEYS = [
  'cacheAllowed',
  'rawPayloadRetentionAllowed',
  'normalizedRetentionAllowed',
  'redistributionAllowed',
  'offlinePackAllowed',
  'exportAllowed',
  'commercialUseAllowed',
  'attributionRequired',
] as const;

/** Minimal literal extraction from a manifest source file (no evaluation). */
export function readManifestSource(source: string): {
  id?: string;
  commercialReview?: string;
  enabledByDefault?: boolean;
  dataPolicy: Record<string, unknown>;
} {
  const out: {
    id?: string;
    commercialReview?: string;
    enabledByDefault?: boolean;
    dataPolicy: Record<string, unknown>;
  } = { dataPolicy: {} };
  const id = source.match(/\bid:\s*'([a-z0-9-]+)'/);
  if (id?.[1]) out.id = id[1];
  const review = source.match(/\bcommercialReview:\s*'([a-z-]+)'/);
  if (review?.[1]) out.commercialReview = review[1];
  const enabled = source.match(/\benabledByDefault:\s*(true|false)/);
  if (enabled) out.enabledByDefault = enabled[1] === 'true';
  const policyBlock = source.match(/dataPolicy:\s*\{([\s\S]*?)\n\s{2}\}/);
  if (policyBlock) {
    for (const key of POLICY_KEYS) {
      const m = policyBlock[1]!.match(new RegExp(`\\b${key}:\\s*(true|false|'[a-z]+')`));
      if (!m) continue;
      const raw = m[1]!;
      out.dataPolicy[key] = raw === 'true' ? true : raw === 'false' ? false : raw.slice(1, -1);
    }
  }
  return out;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/**
 * Every provider manifest: `providers/<dir>/src/manifest.ts`, and a second provider shipped
 * from the same package one directory down (`providers/cctv-public/src/unverified/manifest.ts`
 * — the same code under a stricter manifest). A nested manifest is audited like any other,
 * so a package cannot carry an unaudited provider.
 */
export function findManifests(root: string): Array<{ dir: string; file: string }> {
  const providersDir = path.join(root, 'providers');
  if (!existsSync(providersDir)) return [];
  const out: Array<{ dir: string; file: string }> = [];
  const isFile = (f: string) => existsSync(f) && statSync(f).isFile();
  for (const entry of readdirSync(providersDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'registry') continue;
    const src = path.join(providersDir, entry.name, 'src');
    const file = path.join(src, 'manifest.ts');
    if (isFile(file)) out.push({ dir: entry.name, file });
    if (!existsSync(src)) continue;
    for (const sub of readdirSync(src, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const nested = path.join(src, sub.name, 'manifest.ts');
      if (isFile(nested)) out.push({ dir: `${entry.name}/${sub.name}`, file: nested });
    }
  }
  return out;
}

/** Shipped connector definitions: `connectors/enabled/*.json` (sidecars `*.test.json` are fixtures). */
export function findDefinitions(root: string): string[] {
  const dir = path.join(root, 'connectors', 'enabled');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.test.json') && !f.startsWith('.'))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * The fail-closed policy a definition starts from (ADR-013); `definition.dataPolicy`
 * overlays it. Restated here rather than imported so the audit stays a reader of files;
 * `audit.test.ts` pins these values to `@worldview/connector-sdk`'s `defaultDataPolicy`.
 */
export const DEFINITION_POLICY_DEFAULTS: Readonly<Record<(typeof POLICY_KEYS)[number], unknown>> = Object.freeze({
  cacheAllowed: true,
  rawPayloadRetentionAllowed: false,
  normalizedRetentionAllowed: true,
  redistributionAllowed: false,
  offlinePackAllowed: false,
  exportAllowed: false,
  commercialUseAllowed: 'unknown',
  attributionRequired: true,
});

const REVIEW_TO_COMMERCIAL: Record<string, string> = {
  'user-configured': 'manual-review-required',
  bundled: 'conditional',
  'commercially-reviewed': 'approved',
};

interface DefinitionFacts {
  id: string;
  review: string;
  commercialReview: string;
  enabledByDefault: boolean;
  attributionText: string;
  dataPolicy: Record<string, unknown>;
}

/** What `definitionToManifest` would derive, read from the JSON without evaluating anything. */
export function readDefinitionFacts(text: string): DefinitionFacts | { error: string } {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    return { error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'not an object' };
  const id = typeof doc['id'] === 'string' ? doc['id'] : '';
  if (!id) return { error: 'definition has no readable id' };
  const review = typeof doc['review'] === 'string' ? doc['review'] : 'user-configured';
  const policy = (doc['dataPolicy'] && typeof doc['dataPolicy'] === 'object' ? doc['dataPolicy'] : {}) as Record<
    string,
    unknown
  >;
  const dataPolicy: Record<string, unknown> = { ...DEFINITION_POLICY_DEFAULTS };
  for (const key of POLICY_KEYS) if (policy[key] !== undefined) dataPolicy[key] = policy[key];
  const attribution = doc['attribution'] as { text?: unknown } | undefined;
  return {
    id,
    review,
    commercialReview: REVIEW_TO_COMMERCIAL[review] ?? 'manual-review-required',
    enabledByDefault: review !== 'user-configured' && doc['enabled'] === true,
    attributionText: typeof attribution?.text === 'string' ? attribution.text : '',
    dataPolicy,
  };
}

export function runLicenseAudit(root: string, now: () => number = Date.now): AuditReport {
  const findings: AuditFinding[] = [];
  const providerRecords = readJson<{ records: ProviderRecord[] }>(
    path.join(root, 'config', 'licenses', 'providers.json'),
  ).records;
  const softwareRecords = readJson<{ records: SoftwareRecord[] }>(
    path.join(root, 'config', 'licenses', 'software.json'),
  ).records;
  const assetRecords = readJson<{ records: AssetRecord[] }>(
    path.join(root, 'config', 'licenses', 'assets.json'),
  ).records;
  const byId = new Map(providerRecords.map((r) => [r.providerId, r]));

  const manifests = findManifests(root);
  let matched = 0;
  for (const { dir, file } of manifests) {
    const manifest = readManifestSource(readFileSync(file, 'utf8'));
    if (!manifest.id) {
      findings.push({
        severity: 'error',
        scope: 'provider',
        subject: `providers/${dir}`,
        message: 'manifest has no readable id',
      });
      continue;
    }
    const record = byId.get(manifest.id);
    if (!record) {
      findings.push({
        severity: 'error',
        scope: 'provider',
        subject: manifest.id,
        message: 'no record in config/licenses/providers.json',
      });
      continue;
    }
    matched++;
    if (record.commercialReview !== manifest.commercialReview) {
      findings.push({
        severity: 'error',
        scope: 'provider',
        subject: manifest.id,
        message: `commercialReview mismatch: manifest=${manifest.commercialReview} registry=${record.commercialReview}`,
      });
    }
    for (const key of POLICY_KEYS) {
      const inManifest = manifest.dataPolicy[key];
      if (inManifest === undefined) continue;
      const inRecord = record.dataPolicy?.[key];
      if (inRecord !== inManifest) {
        findings.push({
          severity: 'error',
          scope: 'provider',
          subject: manifest.id,
          message: `dataPolicy.${key} mismatch: manifest=${String(inManifest)} registry=${String(inRecord)}`,
        });
      }
    }
    if (
      manifest.enabledByDefault &&
      (record.commercialReview === 'excluded' || record.commercialReview === 'manual-review-required')
    ) {
      findings.push({
        severity: 'error',
        scope: 'provider',
        subject: manifest.id,
        message: `enabled by default but commercial review is ${record.commercialReview}`,
      });
    }
    if (record.dataPolicy?.['attributionRequired'] === true && !record.dataPolicy['attributionText']) {
      findings.push({
        severity: 'error',
        scope: 'provider',
        subject: manifest.id,
        message: 'attribution required but the record carries no attribution text',
      });
    }
  }

  const definitions = findDefinitions(root);
  for (const file of definitions) {
    const rel = path.relative(root, file);
    const facts = readDefinitionFacts(readFileSync(file, 'utf8'));
    if ('error' in facts) {
      findings.push({ severity: 'error', scope: 'provider', subject: rel, message: facts.error });
      continue;
    }
    if (facts.review === 'user-configured') {
      findings.push({
        severity: 'error',
        scope: 'provider',
        subject: facts.id,
        message: `${rel} is shipped but not reviewed (review: user-configured belongs in the operator's folder)`,
      });
      continue;
    }
    const record = byId.get(facts.id);
    if (!record) {
      findings.push({
        severity: 'error',
        scope: 'provider',
        subject: facts.id,
        message: `no record in config/licenses/providers.json (${rel})`,
      });
      continue;
    }
    matched++;
    if (record.commercialReview !== facts.commercialReview) {
      findings.push({
        severity: 'error',
        scope: 'provider',
        subject: facts.id,
        message: `commercialReview mismatch: definition review "${facts.review}" → ${facts.commercialReview}, registry=${record.commercialReview}`,
      });
    }
    for (const key of POLICY_KEYS) {
      const inRecord = record.dataPolicy?.[key];
      if (inRecord !== facts.dataPolicy[key]) {
        findings.push({
          severity: 'error',
          scope: 'provider',
          subject: facts.id,
          message: `dataPolicy.${key} mismatch: definition=${String(facts.dataPolicy[key])} registry=${String(inRecord)}`,
        });
      }
    }
    if (
      facts.enabledByDefault &&
      (record.commercialReview === 'excluded' || record.commercialReview === 'manual-review-required')
    ) {
      findings.push({
        severity: 'error',
        scope: 'provider',
        subject: facts.id,
        message: `enabled by default but commercial review is ${record.commercialReview}`,
      });
    }
    if (record.dataPolicy?.['attributionRequired'] === true && !facts.attributionText) {
      findings.push({
        severity: 'error',
        scope: 'provider',
        subject: facts.id,
        message: 'attribution required but the definition carries no attribution text',
      });
    }
  }

  let bundled = 0;
  let conditional = 0;
  for (const r of softwareRecords) {
    if (r.distribution === 'bundled') bundled++;
    if (r.commercialReview === 'conditional') conditional++;
    if (r.distribution === 'bundled' && (!r.license || /unknown/i.test(r.license))) {
      findings.push({
        severity: 'error',
        scope: 'software',
        subject: r.name,
        message: 'bundled component has no resolved license',
      });
    }
    if (r.distribution === 'bundled' && r.commercialReview === 'excluded') {
      findings.push({
        severity: 'error',
        scope: 'software',
        subject: r.name,
        message: 'excluded component marked as bundled',
      });
    }
    if (r.commercialReview === 'manual-review-required' && r.distribution !== 'not-distributed') {
      findings.push({
        severity: 'warning',
        scope: 'software',
        subject: r.name,
        message: 'manual review pending while the component is distributed',
      });
    }
  }

  let assetsBundled = 0;
  let assetsImported = 0;
  let assetsClearedNotImported = 0;
  let assetsExcluded = 0;
  let assetsReview = 0;
  for (const a of assetRecords) {
    // Asset paths are recorded as they appear in the upstream God's Eye View tree
    // (docs/legal/ASSET-PROVENANCE.md). A cleared asset only becomes a WORLDVIEW
    // obligation once it is actually imported into this repository.
    const present = !a.path.includes('*') && existsSync(path.join(root, a.path));
    if (a.decision === 'bundle') {
      assetsBundled++;
      if (present) assetsImported++;
      else assetsClearedNotImported++;
    } else if (a.decision === 'exclude') assetsExcluded++;
    else assetsReview++;
    if (a.decision === 'bundle' && (!a.license || /unknown/i.test(a.license))) {
      findings.push({
        severity: 'error',
        scope: 'asset',
        subject: a.path,
        message: 'asset cleared for bundling without a resolved license',
      });
    }
    if (a.decision === 'bundle' && present && !a.attribution && /CC BY|ODbL|OGL/i.test(a.license ?? '')) {
      findings.push({
        severity: 'error',
        scope: 'asset',
        subject: a.path,
        message: 'imported asset requires attribution but the record carries none',
      });
    }
    if (a.decision === 'exclude' && present && !a.path.startsWith('docs/')) {
      findings.push({
        severity: 'error',
        scope: 'asset',
        subject: a.path,
        message: 'asset marked exclude is present in the repository',
      });
    }
    if (a.decision === 'review' && present) {
      findings.push({
        severity: 'warning',
        scope: 'asset',
        subject: a.path,
        message: 'asset pending legal review is present in the repository',
      });
    }
  }

  return {
    ranAt: new Date(now()).toISOString(),
    providers: {
      manifests: manifests.length,
      definitions: definitions.length,
      records: providerRecords.length,
      matched,
    },
    software: { records: softwareRecords.length, bundled, conditional },
    assets: {
      records: assetRecords.length,
      bundled: assetsBundled,
      imported: assetsImported,
      clearedNotImported: assetsClearedNotImported,
      excluded: assetsExcluded,
      review: assetsReview,
    },
    findings,
    passed: findings.every((f) => f.severity !== 'error'),
  };
}

export function formatAudit(report: AuditReport): string {
  const lines = [
    `Providers  ${report.providers.matched}/${report.providers.manifests + report.providers.definitions} manifests and definitions matched against ${report.providers.records} registry records`,
    `Software   ${report.software.records} records (${report.software.bundled} bundled, ${report.software.conditional} conditional)`,
    `Assets     ${report.assets.records} records (${report.assets.bundled} cleared: ${report.assets.imported} imported / ${report.assets.clearedNotImported} not imported, ${report.assets.excluded} excluded, ${report.assets.review} review)`,
  ];
  for (const f of report.findings)
    lines.push(`${f.severity.toUpperCase().padEnd(7)} ${f.scope}/${f.subject}: ${f.message}`);
  lines.push(
    `${report.findings.filter((f) => f.severity === 'error').length} errors, ${report.findings.filter((f) => f.severity === 'warning').length} warnings → ${report.passed ? 'PASS' : 'FAIL'}`,
  );
  return lines.join('\n');
}
