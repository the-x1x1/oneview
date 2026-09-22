import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  circleBounds,
  isValidBounds,
  systemClock,
  type Clock,
  type GeoBounds,
  type GeoPosition,
  type JsonValue,
} from '@worldview/world-model';
import { mayIncludeInWorldpack, type ProviderDataPolicy } from '@worldview/provider-sdk';
import { silentLogger, type Logger } from '@worldview/core';
import { writeFileAtomic } from '@worldview/core/node';
import { rowToLine, type HistoryRow, type HistoryStore } from '@worldview/history-store';
import { clipFeatureCollection, parseFeatureCollection, type PackFeatureCollection } from './geojson.js';
import {
  WORLDPACK_EXTENSION,
  WORLDPACK_MANIFEST_PATH,
  WORLDPACK_NOTICES_PATH,
  WORLDPACK_SEARCH_INDEX_PATH,
  isSemver,
  parseWorldPackManifest,
  type WorldPackContent,
  type WorldPackContentKind,
  type WorldPackManifest,
  type WorldPackSourcePolicy,
} from './manifest.js';
import { renderNotices } from './notices.js';
import { airportsFromFeatures, placesFromFeatures } from './place-entries.js';
import { PlaceIndex } from './place-index.js';
import { regionPreset } from './region-presets.js';
import { ZIP_METHOD_DEFLATE, ZIP_METHOD_STORE, ZipWriter, type ZipWrittenEntry } from './zip.js';

/**
 * WorldPackBuilder — assembles a `.worldpack` from local sources (ADR-007).
 *
 * Fails closed: every included source must resolve to a data policy with
 * `offlinePackAllowed && redistributionAllowed`; anything else refuses the whole
 * build before a byte is written. Sources are clipped to the pack bounds, the
 * place index is derived from the place/airport layers, NOTICES.md is generated
 * from the policies' attribution, and a build report is written next to the pack.
 */
export type WorldPackInclude = 'map' | 'places' | 'airports' | 'earthquakes';
export const WORLDPACK_INCLUDES: readonly WorldPackInclude[] = Object.freeze([
  'map',
  'places',
  'airports',
  'earthquakes',
]);

export type WorldPackRegionInput =
  | { bounds: GeoBounds }
  | { preset: string }
  | { center: GeoPosition; radiusM: number };

/** Provider ids under which the bundled seed fixtures are recorded (MIT, see the README in fixtures/places and fixtures/airports). */
export const SEED_PLACES_PROVIDER_ID = 'worldview-seed-places';
export const SEED_AIRPORTS_PROVIDER_ID = 'worldview-seed-airports';
export const DEFAULT_MAP_PROVIDER_ID = 'protomaps-builds';
export const DEFAULT_EARTHQUAKE_PROVIDER_IDS: readonly string[] = Object.freeze(['usgs-earthquakes']);

export const SEED_DATA_POLICY: ProviderDataPolicy = Object.freeze({
  cacheAllowed: true,
  rawPayloadRetentionAllowed: true,
  normalizedRetentionAllowed: true,
  redistributionAllowed: true,
  offlinePackAllowed: true,
  exportAllowed: true,
  commercialUseAllowed: true,
  attributionRequired: false,
  attributionText: 'Seed places and airports: WORLDVIEW project (MIT)',
});

/** Policies for the bundled seed fixtures; merge these over the legal registry lookup. */
export function seedPolicies(): Record<string, ProviderDataPolicy> {
  return { [SEED_PLACES_PROVIDER_ID]: SEED_DATA_POLICY, [SEED_AIRPORTS_PROVIDER_ID]: SEED_DATA_POLICY };
}

export interface WorldPackSources {
  pmtilesPath?: string;
  pmtilesProviderId?: string;
  placesGeoJsonPath?: string;
  placesProviderId?: string;
  airportsGeoJsonPath?: string;
  airportsProviderId?: string;
  history?: HistoryStore;
  /** Days of earthquake history to pack (default 365). */
  earthquakeWindowDays?: number;
  earthquakeProviderIds?: string[];
}

export interface WorldPackBuildRequest {
  id: string;
  name: string;
  version?: string;
  region: WorldPackRegionInput;
  include: WorldPackInclude[];
  sources: WorldPackSources;
  policies: (providerId: string) => ProviderDataPolicy | undefined;
  /** Licence name per provider for NOTICES.md (config/licenses/providers.json `license`). */
  licenses?: (providerId: string) => string | undefined;
  outputPath: string;
  reportPath?: string;
  minimumAppVersion?: string;
  expiresAt?: string;
  clock?: Clock;
  logger?: Logger;
}

export interface WorldPackBuildReport {
  ok: true;
  id: string;
  name: string;
  outputPath: string;
  reportPath: string;
  sizeBytes: number;
  createdAt: string;
  durationMs: number;
  bounds: GeoBounds;
  include: WorldPackInclude[];
  entries: Array<WorldPackContent & { compressedBytes: number }>;
  sources: WorldPackSourcePolicy[];
  layers: {
    map?: { sourcePath: string; sizeBytes: number };
    places?: { sourceFeatures: number; kept: number; dropped: number; indexed: number; skipped: number };
    airports?: { sourceFeatures: number; kept: number; dropped: number; indexed: number; skipped: number };
    earthquakes?: { rows: number; providers: string[]; window: { start: string; end: string } };
  };
  searchIndexEntries: number;
  warnings: string[];
}

export type WorldPackBuildErrorCode =
  | 'INVALID_REQUEST'
  | 'SOURCE_MISSING'
  | 'INVALID_SOURCE'
  | 'POLICY_REFUSED'
  | 'WRITE_FAILED';

export class WorldPackBuildError extends Error {
  constructor(
    readonly code: WorldPackBuildErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorldPackBuildError';
  }
}

const PMTILES_MAGIC = Buffer.from('PMTiles', 'ascii');
const PMTILES_VERSION = 3;

interface PendingFile {
  content: Omit<WorldPackContent, 'sha256' | 'sizeBytes'>;
  data: Uint8Array | { file: string };
  method: typeof ZIP_METHOD_DEFLATE | typeof ZIP_METHOD_STORE;
}

export function resolveRegionBounds(region: WorldPackRegionInput): GeoBounds {
  if ('bounds' in region) {
    if (!isValidBounds(region.bounds)) throw new WorldPackBuildError('INVALID_REQUEST', 'region bounds are invalid');
    return region.bounds;
  }
  if ('preset' in region) {
    const p = regionPreset(region.preset);
    if (!p) throw new WorldPackBuildError('INVALID_REQUEST', `unknown region preset "${region.preset}"`);
    return p.bounds;
  }
  if (!(region.radiusM > 0) || !Number.isFinite(region.radiusM))
    throw new WorldPackBuildError('INVALID_REQUEST', 'radiusM must be > 0');
  return circleBounds(region.center, region.radiusM);
}

export class WorldPackBuilder {
  async build(req: WorldPackBuildRequest): Promise<WorldPackBuildReport> {
    const clock = req.clock ?? systemClock;
    const log = req.logger ?? silentLogger;
    const startedAt = clock.now();
    const createdAt = new Date(startedAt).toISOString();
    const warnings: string[] = [];

    // ---- request validation -------------------------------------------------
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(req.id))
      throw new WorldPackBuildError('INVALID_REQUEST', `pack id "${req.id}" must be kebab-case (2-64 chars)`);
    if (!req.name.trim()) throw new WorldPackBuildError('INVALID_REQUEST', 'pack name is required');
    if (req.include.length === 0) throw new WorldPackBuildError('INVALID_REQUEST', 'include at least one layer');
    for (const inc of req.include)
      if (!WORLDPACK_INCLUDES.includes(inc))
        throw new WorldPackBuildError('INVALID_REQUEST', `unknown include "${inc}"`);
    const minimumAppVersion = req.minimumAppVersion ?? '0.1.0';
    if (!isSemver(minimumAppVersion))
      throw new WorldPackBuildError('INVALID_REQUEST', `minimumAppVersion "${minimumAppVersion}" is not semver`);
    if (req.version !== undefined && !isSemver(req.version))
      throw new WorldPackBuildError('INVALID_REQUEST', `version "${req.version}" is not semver`);
    if (!req.outputPath.endsWith(WORLDPACK_EXTENSION))
      throw new WorldPackBuildError('INVALID_REQUEST', `outputPath must end with ${WORLDPACK_EXTENSION}`);
    const bounds = resolveRegionBounds(req.region);
    const include = [...new Set(req.include)];

    // ---- resolve sources and gate on policy BEFORE touching the output ------
    const providerIds = new Set<string>();
    const mapProvider = req.sources.pmtilesProviderId ?? DEFAULT_MAP_PROVIDER_ID;
    const placesProvider = req.sources.placesProviderId ?? SEED_PLACES_PROVIDER_ID;
    const airportsProvider = req.sources.airportsProviderId ?? SEED_AIRPORTS_PROVIDER_ID;
    const quakeProviders = req.sources.earthquakeProviderIds ?? [...DEFAULT_EARTHQUAKE_PROVIDER_IDS];

    if (include.includes('map')) {
      if (!req.sources.pmtilesPath)
        throw new WorldPackBuildError('SOURCE_MISSING', 'include "map" needs sources.pmtilesPath');
      providerIds.add(mapProvider);
    }
    if (include.includes('places')) {
      if (!req.sources.placesGeoJsonPath)
        throw new WorldPackBuildError('SOURCE_MISSING', 'include "places" needs sources.placesGeoJsonPath');
      providerIds.add(placesProvider);
    }
    if (include.includes('airports')) {
      if (!req.sources.airportsGeoJsonPath)
        throw new WorldPackBuildError('SOURCE_MISSING', 'include "airports" needs sources.airportsGeoJsonPath');
      providerIds.add(airportsProvider);
    }
    if (include.includes('earthquakes')) {
      if (!req.sources.history)
        throw new WorldPackBuildError('SOURCE_MISSING', 'include "earthquakes" needs sources.history (a HistoryStore)');
      if (quakeProviders.length === 0)
        throw new WorldPackBuildError('INVALID_REQUEST', 'earthquakeProviderIds must name at least one provider');
      for (const p of quakeProviders) providerIds.add(p);
    }

    const sourcePolicies = new Map<string, WorldPackSourcePolicy>();
    for (const providerId of providerIds) sourcePolicies.set(providerId, gatePolicy(providerId, req));

    // ---- gather layer data ---------------------------------------------------
    const pending: PendingFile[] = [];
    const layers: WorldPackBuildReport['layers'] = {};
    const placeIndex = new PlaceIndex();

    if (include.includes('map')) {
      const file = req.sources.pmtilesPath!;
      const stat = await statOrThrow(file, 'map');
      await assertPmtiles(file);
      const base = path
        .basename(file)
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/\.pmtiles$/i, '');
      pending.push({
        content: { path: `maps/${base || 'basemap'}.pmtiles`, kind: 'pmtiles', providerId: mapProvider },
        data: { file },
        method: ZIP_METHOD_STORE,
      });
      layers.map = { sourcePath: file, sizeBytes: stat.size };
    }

    if (include.includes('places')) {
      const collection = await readFeatureCollection(req.sources.placesGeoJsonPath!, 'places');
      const clipped = clipFeatureCollection(collection, bounds);
      const conv = placesFromFeatures(clipped.collection);
      placeIndex.add(conv.entries);
      pending.push({
        content: {
          path: 'data/places.geojson',
          kind: 'geojson',
          providerId: placesProvider,
          objectType: 'place',
          rowCount: clipped.kept,
        },
        data: encodeJson(clipped.collection),
        method: ZIP_METHOD_DEFLATE,
      });
      layers.places = {
        sourceFeatures: collection.features.length,
        kept: clipped.kept,
        dropped: clipped.dropped,
        indexed: conv.entries.length,
        skipped: conv.skipped,
      };
      if (clipped.kept === 0) warnings.push('places layer is empty inside the pack bounds');
    }

    if (include.includes('airports')) {
      const collection = await readFeatureCollection(req.sources.airportsGeoJsonPath!, 'airports');
      const clipped = clipFeatureCollection(collection, bounds);
      const conv = airportsFromFeatures(clipped.collection);
      placeIndex.add(conv.entries);
      pending.push({
        content: {
          path: 'data/airports.geojson',
          kind: 'geojson',
          providerId: airportsProvider,
          objectType: 'airport',
          rowCount: clipped.kept,
        },
        data: encodeJson(clipped.collection),
        method: ZIP_METHOD_DEFLATE,
      });
      layers.airports = {
        sourceFeatures: collection.features.length,
        kept: clipped.kept,
        dropped: clipped.dropped,
        indexed: conv.entries.length,
        skipped: conv.skipped,
      };
      if (clipped.kept === 0) warnings.push('airports layer is empty inside the pack bounds');
    }

    if (include.includes('earthquakes')) {
      const days = req.sources.earthquakeWindowDays ?? 365;
      if (!(days > 0)) throw new WorldPackBuildError('INVALID_REQUEST', 'earthquakeWindowDays must be > 0');
      const end = createdAt;
      const start = new Date(startedAt - days * 86_400_000).toISOString();
      let rows: HistoryRow[];
      try {
        rows = await req.sources.history!.observationsInRange({
          objectTypes: ['earthquake'],
          providerIds: quakeProviders,
          region: { kind: 'bounds', bounds },
          time: { start, end },
        });
      } catch (err) {
        throw new WorldPackBuildError('INVALID_SOURCE', `history query failed: ${errText(err)}`, { cause: err });
      }
      const foreign = rows.filter((r) => !quakeProviders.includes(r.providerId));
      if (foreign.length)
        throw new WorldPackBuildError(
          'POLICY_REFUSED',
          `history returned rows from providers without a gated policy: ${[...new Set(foreign.map((r) => r.providerId))].join(', ')}`,
        );
      const byProvider = new Map<string, HistoryRow[]>();
      for (const r of rows) {
        const list = byProvider.get(r.providerId);
        if (list) list.push(r);
        else byProvider.set(r.providerId, [r]);
      }
      if (byProvider.size === 0) byProvider.set(quakeProviders[0]!, []);
      const single = byProvider.size === 1;
      for (const [providerId, list] of byProvider) {
        const ndjson = list.map(rowToLine).join('\n') + (list.length ? '\n' : '');
        const file = single ? 'data/earthquakes.ndjson' : `data/earthquakes-${providerId}.ndjson`;
        pending.push({
          content: { path: file, kind: 'ndjson', providerId, objectType: 'earthquake', rowCount: list.length },
          data: Buffer.from(ndjson, 'utf8'),
          method: ZIP_METHOD_DEFLATE,
        });
      }
      layers.earthquakes = { rows: rows.length, providers: [...byProvider.keys()], window: { start, end } };
      if (rows.length === 0)
        warnings.push(`no earthquake rows in history for the last ${days} days inside the pack bounds`);
    }

    if (placeIndex.size > 0) {
      pending.push({
        content: { path: WORLDPACK_SEARCH_INDEX_PATH, kind: 'search-index', rowCount: placeIndex.size },
        data: encodeJson(placeIndex.toJSON()),
        method: ZIP_METHOD_DEFLATE,
      });
    } else if (include.includes('places') || include.includes('airports')) {
      warnings.push('search index is empty (no places or airports inside the bounds)');
    }

    // Drop source policies that ended up unused (e.g. earthquakes with several candidate providers but rows from one).
    const usedProviders = new Set(pending.map((p) => p.content.providerId).filter((p): p is string => p !== undefined));
    for (const id of [...sourcePolicies.keys()]) if (!usedProviders.has(id)) sourcePolicies.delete(id);

    // ---- write archive -------------------------------------------------------
    await fs.mkdir(path.dirname(path.resolve(req.outputPath)), { recursive: true });
    const tmpOut = `${req.outputPath}.${process.pid}.partial`;
    const writer = await ZipWriter.create(tmpOut, { mtime: new Date(startedAt) });
    const contents: WorldPackContent[] = [];
    const written: ZipWrittenEntry[] = [];
    try {
      for (const p of pending) {
        const w = await writer.add({ name: p.content.path, data: p.data, method: p.method });
        written.push(w);
        contents.push({ ...p.content, sizeBytes: w.uncompressedSize, sha256: w.sha256 });
      }
      const sources = [...sourcePolicies.values()];
      const noticesDraft = renderNotices({ id: req.id, name: req.name, createdAt, bounds, sources, contents });
      const noticesEntry = await writer.add({
        name: WORLDPACK_NOTICES_PATH,
        data: Buffer.from(noticesDraft, 'utf8'),
        method: ZIP_METHOD_DEFLATE,
      });
      written.push(noticesEntry);
      contents.push({
        path: WORLDPACK_NOTICES_PATH,
        kind: 'notices',
        sizeBytes: noticesEntry.uncompressedSize,
        sha256: noticesEntry.sha256,
      });

      const manifest: WorldPackManifest = {
        formatVersion: 1,
        id: req.id,
        name: req.name,
        ...(req.version !== undefined ? { version: req.version } : {}),
        createdAt,
        ...(req.expiresAt !== undefined ? { expiresAt: req.expiresAt } : {}),
        geographicBounds: bounds,
        contents,
        sourcePolicies: sources,
        minimumAppVersion,
        checksums: Object.fromEntries(contents.map((c) => [c.path, c.sha256])),
      };
      const check = parseWorldPackManifest(JSON.parse(JSON.stringify(manifest)));
      if (!check.ok)
        throw new WorldPackBuildError('INVALID_REQUEST', `generated manifest is invalid: ${check.issues.join('; ')}`);
      const manifestEntry = await writer.add({
        name: WORLDPACK_MANIFEST_PATH,
        data: encodeJson(manifest),
        method: ZIP_METHOD_DEFLATE,
      });
      written.push(manifestEntry);
      const finished = await writer.finish();
      await fs.rename(tmpOut, req.outputPath);

      const reportPath = req.reportPath ?? `${req.outputPath}.build-report.json`;
      const report: WorldPackBuildReport = {
        ok: true,
        id: req.id,
        name: req.name,
        outputPath: req.outputPath,
        reportPath,
        sizeBytes: finished.sizeBytes,
        createdAt,
        durationMs: clock.now() - startedAt,
        bounds,
        include,
        entries: contents.map((c) => ({
          ...c,
          compressedBytes: written.find((w) => w.name === c.path)?.compressedSize ?? 0,
        })),
        sources,
        layers,
        searchIndexEntries: placeIndex.size,
        warnings,
      };
      await writeFileAtomic(reportPath, JSON.stringify(report, null, 2) + '\n');
      log.info('worldpack built', {
        id: req.id,
        sizeBytes: finished.sizeBytes,
        entries: contents.length,
        warnings: warnings.length,
      });
      return report;
    } catch (err) {
      await writer.abort().catch(() => undefined);
      await fs.rm(tmpOut, { force: true }).catch(() => undefined);
      if (err instanceof WorldPackBuildError) throw err;
      throw new WorldPackBuildError('WRITE_FAILED', `failed to write ${req.outputPath}: ${errText(err)}`, {
        cause: err,
      });
    }
  }
}

function gatePolicy(providerId: string, req: WorldPackBuildRequest): WorldPackSourcePolicy {
  const policy = req.policies(providerId);
  if (!policy)
    throw new WorldPackBuildError(
      'POLICY_REFUSED',
      `provider "${providerId}": no data policy is registered — refusing to pack data of unknown licence`,
    );
  if (!mayIncludeInWorldpack(policy)) {
    throw new WorldPackBuildError(
      'POLICY_REFUSED',
      `provider "${providerId}": offlinePackAllowed=${policy.offlinePackAllowed}, redistributionAllowed=${policy.redistributionAllowed} — its data policy does not permit inclusion in a world pack`,
    );
  }
  if (policy.attributionRequired && !policy.attributionText)
    throw new WorldPackBuildError(
      'POLICY_REFUSED',
      `provider "${providerId}": attribution is required but no attribution text is declared`,
    );
  const out: WorldPackSourcePolicy = {
    providerId,
    license: req.licenses?.(providerId) ?? 'not declared — see terms',
    attribution: policy.attributionText ?? `${providerId} (no attribution text declared)`,
    offlinePackAllowed: policy.offlinePackAllowed,
    redistributionAllowed: policy.redistributionAllowed,
  };
  if (policy.termsUrl) out.termsUrl = policy.termsUrl;
  return out;
}

async function statOrThrow(file: string, layer: string): Promise<{ size: number }> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) throw new WorldPackBuildError('SOURCE_MISSING', `${layer}: ${file} is not a file`);
    return { size: st.size };
  } catch (err) {
    if (err instanceof WorldPackBuildError) throw err;
    throw new WorldPackBuildError('SOURCE_MISSING', `${layer}: cannot read ${file}: ${errText(err)}`, { cause: err });
  }
}

async function assertPmtiles(file: string): Promise<void> {
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    if (bytesRead < 8 || !head.subarray(0, 7).equals(PMTILES_MAGIC) || head[7] !== PMTILES_VERSION) {
      throw new WorldPackBuildError('INVALID_SOURCE', `${file} is not a PMTiles v3 archive`);
    }
  } finally {
    await handle.close();
  }
}

async function readFeatureCollection(file: string, layer: string): Promise<PackFeatureCollection> {
  await statOrThrow(file, layer);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw new WorldPackBuildError('INVALID_SOURCE', `${layer}: ${file} is not valid JSON: ${errText(err)}`, {
      cause: err,
    });
  }
  const parsed = parseFeatureCollection(raw);
  if (!parsed.ok)
    throw new WorldPackBuildError(
      'INVALID_SOURCE',
      `${layer}: ${file} is not a valid FeatureCollection: ${parsed.issues.slice(0, 5).join('; ')}`,
    );
  return parsed.collection;
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value as JsonValue), 'utf8');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { WorldPackContentKind };
