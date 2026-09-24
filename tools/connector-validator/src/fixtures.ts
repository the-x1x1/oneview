import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Observation } from '@worldview/world-model';
import type { SuiteFixtures } from '@worldview/connector-runtime';

/**
 * A definition's test sidecar — `<definition>.test.json` beside the definition — names the
 * fixtures the shared suite runs it against and what they must produce. It is data, like
 * the definition: file paths (relative to the repository root) or `{ "inline": "…" }`
 * bodies, counts and ids, and optional per-observation expectations compared field by
 * field. No code: a check the sidecar cannot express belongs in a `*.test.ts`.
 */
export const SIDECAR_SCHEMA_ID = 'oneview.connector-test.v1';

export interface SidecarBody {
  inline: string;
}
export type SidecarSource = string | SidecarBody;

export interface ExpectedObservation {
  externalId: string;
  observedAt?: string;
  position?: { latitude?: number; longitude?: number; altitudeM?: number | null };
  /** Payload fields (labels land there too) that must equal these values (numbers within 1e-6). */
  payload?: Record<string, unknown>;
  attribution?: string;
  flags?: string[];
}

export interface Sidecar {
  schema?: string;
  normal: SidecarSource | SidecarSource[];
  empty: SidecarSource;
  malformed: SidecarSource[];
  expectObservations: number;
  expectIds?: string[];
  expect?: ExpectedObservation[];
}

export function sidecarPathFor(definitionPath: string): string {
  const dir = path.dirname(definitionPath);
  const base = path.basename(definitionPath).replace(/\.json$/i, '');
  return path.join(dir, `${base}.test.json`);
}

function readSource(src: SidecarSource, root: string, what: string): string {
  if (typeof src === 'object' && src !== null && 'inline' in src) return String(src.inline);
  if (typeof src !== 'string') throw new Error(`${what}: expected a fixture path or { "inline": "…" }`);
  const abs = path.resolve(root, src);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error(`${what}: fixture ${src} is outside the repository`);
  if (!existsSync(abs)) throw new Error(`${what}: fixture ${src} not found`);
  return readFileSync(abs, 'utf8');
}

export function parseSidecar(text: string, file: string): Sidecar {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file}: expected an object`);
  const s = doc as Record<string, unknown>;
  if (s['schema'] !== undefined && s['schema'] !== SIDECAR_SCHEMA_ID)
    throw new Error(`${file}: schema must be ${SIDECAR_SCHEMA_ID}`);
  if (s['normal'] === undefined) throw new Error(`${file}: "normal" is required`);
  if (s['empty'] === undefined) throw new Error(`${file}: "empty" is required`);
  if (!Array.isArray(s['malformed'])) throw new Error(`${file}: "malformed" must be an array`);
  if (
    typeof s['expectObservations'] !== 'number' ||
    !Number.isInteger(s['expectObservations']) ||
    s['expectObservations'] < 0
  )
    throw new Error(`${file}: "expectObservations" must be a non-negative integer`);
  if (
    s['expectIds'] !== undefined &&
    (!Array.isArray(s['expectIds']) || !s['expectIds'].every((x) => typeof x === 'string'))
  )
    throw new Error(`${file}: "expectIds" must be an array of strings`);
  if (s['expect'] !== undefined) {
    if (!Array.isArray(s['expect'])) throw new Error(`${file}: "expect" must be an array`);
    for (const [i, e] of s['expect'].entries())
      if (!e || typeof e !== 'object' || typeof (e as ExpectedObservation).externalId !== 'string')
        throw new Error(`${file}: expect[${i}] needs an externalId`);
  }
  return s as unknown as Sidecar;
}

export function loadSidecar(file: string, root: string): SuiteFixtures {
  const sidecar = parseSidecar(readFileSync(file, 'utf8'), path.relative(root, file));
  const name = path.relative(root, file);
  const normal = Array.isArray(sidecar.normal)
    ? sidecar.normal.map((s, i) => readSource(s, root, `${name} normal[${i}]`))
    : readSource(sidecar.normal, root, `${name} normal`);
  const fixtures: SuiteFixtures = {
    normal,
    empty: readSource(sidecar.empty, root, `${name} empty`),
    malformed: sidecar.malformed.map((s, i) => readSource(s, root, `${name} malformed[${i}]`)),
    expectObservations: sidecar.expectObservations,
  };
  if (sidecar.expectIds) fixtures.expectIds = sidecar.expectIds;
  if (sidecar.expect?.length) fixtures.verify = (obs) => verifyExpected(obs, sidecar.expect!);
  return fixtures;
}

const near = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)) : a === b;

export function verifyExpected(observations: Observation[], expected: ExpectedObservation[]): string | undefined {
  for (const e of expected) {
    const o = observations.find((x) => x.externalId === e.externalId);
    if (!o) return `no observation with externalId ${e.externalId}`;
    const where = `observation ${e.externalId}`;
    if (e.observedAt !== undefined && o.observedAt !== e.observedAt)
      return `${where}: observedAt ${o.observedAt}, expected ${e.observedAt}`;
    if (e.attribution !== undefined && o.provenance.attribution !== e.attribution)
      return `${where}: attribution ${JSON.stringify(o.provenance.attribution)}`;
    if (e.position) {
      if (!o.position) return `${where}: no position`;
      for (const k of ['latitude', 'longitude', 'altitudeM'] as const) {
        const want = e.position[k];
        if (want === undefined) continue;
        const got = o.position[k];
        if (want === null ? got !== undefined : !near(got, want))
          return `${where}: position.${k} is ${String(got)}, expected ${String(want)}`;
      }
    }
    for (const [k, want] of Object.entries(e.payload ?? {})) {
      const got = o.payload[k];
      if (want === null ? got !== undefined : !near(got, want))
        return `${where}: payload.${k} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
    }
    for (const f of e.flags ?? []) if (!o.quality.flags?.includes(f as never)) return `${where}: flag ${f} missing`;
  }
  return undefined;
}
