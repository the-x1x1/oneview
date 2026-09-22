import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseLockfile, type LockedPackage } from './lockfile.js';

/**
 * CycloneDX 1.5 SBOM for a WORLDVIEW release (directive §80).
 *
 * Components come from three places:
 *   1. the resolved dependency graph (pnpm-lock.yaml) — third-party npm packages;
 *   2. the workspace packages themselves — so a consumer can see what is first-party;
 *   3. config/licenses/software.json — sidecars and external processes that are not
 *      npm dependencies (readsb, go2rtc) but are part of the deployed system.
 *
 * Licenses for npm packages are read from the installed node_modules metadata when it
 * is present; otherwise the component carries no license claim rather than a guess,
 * and `metadata.properties` records that the build had no installed tree.
 */
export interface SbomOptions {
  root: string;
  version: string;
  commit?: string;
  /** Include devDependencies (default false: a release SBOM lists what ships). */
  includeDev?: boolean;
  now?: () => number;
}

export interface SbomComponent {
  type: 'library' | 'application' | 'framework';
  'bom-ref': string;
  name: string;
  version: string;
  scope?: 'required' | 'optional' | 'excluded';
  purl?: string;
  licenses?: Array<{ license: { id?: string; name?: string } }>;
  hashes?: Array<{ alg: string; content: string }>;
  properties?: Array<{ name: string; value: string }>;
}

export interface Sbom {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  serialNumber: string;
  version: 1;
  metadata: {
    timestamp: string;
    component: { type: 'application'; 'bom-ref': string; name: string; version: string };
    tools: { components: Array<{ type: 'application'; name: string; version: string }> };
    properties: Array<{ name: string; value: string }>;
  };
  components: SbomComponent[];
}

function purl(name: string, version: string): string {
  const [scope, bare] = name.startsWith('@') ? [name.slice(0, name.indexOf('/')), name.slice(name.indexOf('/') + 1)] : [undefined, name];
  return scope ? `pkg:npm/${encodeURIComponent(scope)}/${bare}@${version}` : `pkg:npm/${bare}@${version}`;
}

function readLicense(root: string, name: string): string | undefined {
  const file = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { license?: string | { type?: string }; licenses?: Array<{ type?: string }> };
    if (typeof pkg.license === 'string') return pkg.license;
    if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
    if (Array.isArray(pkg.licenses) && pkg.licenses[0]?.type) return pkg.licenses[0].type;
  } catch { /* unreadable metadata is reported as "no claim" */ }
  return undefined;
}

function workspacePackages(root: string): Array<{ dir: string; name: string; version: string }> {
  const out: Array<{ dir: string; name: string; version: string }> = [];
  for (const group of ['packages', 'providers', 'tools', 'apps']) {
    const base = path.join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(base, entry.name, 'package.json');
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      try {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name) out.push({ dir: `${group}/${entry.name}`, name: pkg.name, version: pkg.version ?? '0.0.0' });
      } catch { /* ignore unreadable workspace manifest */ }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface SoftwareRecord { name: string; license?: string; commitOrVersion?: string; integration?: string; distribution?: string; repository?: string }

export function buildSbom(opts: SbomOptions): Sbom {
  const now = new Date((opts.now ?? Date.now)()).toISOString();
  const lockPath = path.join(opts.root, 'pnpm-lock.yaml');
  const hasLock = existsSync(lockPath);
  const lockText = hasLock ? readFileSync(lockPath, 'utf8') : '';
  const lock = hasLock ? parseLockfile(lockText) : { lockfileVersion: 'absent', packages: [] as LockedPackage[], importers: [] as string[] };
  const hasNodeModules = existsSync(path.join(opts.root, 'node_modules'));

  const components: SbomComponent[] = [];

  for (const p of lock.packages) {
    if (p.dev && !opts.includeDev) continue;
    const license = readLicense(opts.root, p.name);
    const component: SbomComponent = {
      type: 'library',
      'bom-ref': purl(p.name, p.version),
      name: p.name,
      version: p.version,
      scope: 'required',
      purl: purl(p.name, p.version),
    };
    if (license) component.licenses = [{ license: { id: license } }];
    if (p.integrity) component.hashes = [{ alg: p.integrity.startsWith('sha512-') ? 'SHA-512' : 'SHA-256', content: p.integrity.replace(/^sha\d+-/, '') }];
    if (p.dev) component.properties = [{ name: 'worldview:scope', value: 'development' }];
    components.push(component);
  }

  for (const w of workspacePackages(opts.root)) {
    components.push({
      type: 'library',
      'bom-ref': `worldview:${w.name}@${w.version}`,
      name: w.name,
      version: w.version,
      scope: 'required',
      licenses: [{ license: { id: 'MIT' } }],
      properties: [{ name: 'worldview:workspace', value: w.dir }],
    });
  }

  const softwareFile = path.join(opts.root, 'config', 'licenses', 'software.json');
  if (existsSync(softwareFile)) {
    const records = (JSON.parse(readFileSync(softwareFile, 'utf8')) as { records: SoftwareRecord[] }).records;
    for (const r of records) {
      if (r.integration !== 'sidecar' && r.integration !== 'external-service') continue;
      const component: SbomComponent = {
        type: 'application',
        'bom-ref': `external:${r.name}@${r.commitOrVersion ?? 'unpinned'}`,
        name: r.name,
        version: r.commitOrVersion ?? 'unpinned',
        scope: r.distribution === 'not-distributed' ? 'excluded' : 'optional',
        properties: [
          { name: 'worldview:integration', value: r.integration },
          { name: 'worldview:distribution', value: r.distribution ?? 'unknown' },
          ...(r.repository ? [{ name: 'worldview:repository', value: r.repository }] : []),
        ],
      };
      if (r.license) component.licenses = [{ license: { name: r.license } }];
      components.push(component);
    }
  }

  const properties = [
    { name: 'worldview:lockfile', value: hasLock ? `pnpm-lock.yaml (v${lock.lockfileVersion})` : 'absent' },
    { name: 'worldview:lockfileSha256', value: hasLock ? createHash('sha256').update(lockText).digest('hex') : 'n/a' },
    { name: 'worldview:licenseSource', value: hasNodeModules ? 'installed node_modules metadata' : 'not resolved (no installed tree in this build environment)' },
    { name: 'worldview:node', value: process.version },
    ...(opts.commit ? [{ name: 'worldview:commit', value: opts.commit }] : []),
  ];

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${deterministicUuid(`${opts.version}:${properties[1]!.value}:${components.length}`)}`,
    version: 1,
    metadata: {
      timestamp: now,
      component: { type: 'application', 'bom-ref': `worldview@${opts.version}`, name: 'WorldView', version: opts.version },
      tools: { components: [{ type: 'application', name: 'worldview-sbom', version: '0.1.0' }] },
      properties,
    },
    components,
  };
}

/** Stable UUIDv5-shaped identifier so re-running the tool on the same input is reproducible. */
export function deterministicUuid(input: string): string {
  const h = createHash('sha256').update(input).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
