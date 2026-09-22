import { epochToIso, isValidLatLon, stableStringify, type JsonValue } from '@worldview/world-model';
import { buildObservation, type ObservationDraft } from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import { USGS_MANIFEST } from './manifest.js';

/**
 * Normalizer for USGS GeoJSON summary feeds and FDSN event-query responses
 * (same feature schema). Adapted from GEV `src/layers/earthquakes/records.js`
 * with the same admission rules: invalid coordinates/magnitudes reject the row;
 * a non-empty feed yielding zero valid rows is malformed (atomic admission).
 */
export interface UsgsFeature {
  type: 'Feature';
  id?: string | number | null;
  properties: Record<string, unknown> | null;
  geometry: { type: 'Point'; coordinates: unknown } | null;
}

export interface NormalizeOptions {
  receivedAt: string;
  minMagnitude?: number;
  hash?: (input: string) => string;
  origin?: 'live' | 'cached' | 'historical' | 'recorded';
  sourceRef?: string;
}

export interface NormalizeResult {
  observations: Observation[];
  total: number;
  rejected: Array<{ index: number; reason: string }>;
  /** Feed metadata timestamp (ms) when present. */
  generatedAt?: string;
}

const MAG_TYPES = new Set([
  'md',
  'ml',
  'ms',
  'mw',
  'me',
  'mi',
  'mb',
  'mlg',
  'mwr',
  'mww',
  'mwc',
  'mwb',
  'mb_lg',
  'mh',
  'mun',
  'mint',
]);

export function normalizeUsgsFeed(payload: unknown, opts: NormalizeOptions): NormalizeResult {
  const rejected: Array<{ index: number; reason: string }> = [];
  if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'FeatureCollection') {
    return { observations: [], total: 0, rejected: [{ index: -1, reason: 'not a FeatureCollection' }] };
  }
  const collection = payload as { features?: unknown; metadata?: { generated?: unknown } };
  const features = Array.isArray(collection.features) ? (collection.features as unknown[]) : [];
  const observations: Observation[] = [];
  const seen = new Set<string>();
  const minMag = opts.minMagnitude ?? Number.NEGATIVE_INFINITY;

  features.forEach((raw, index) => {
    const draft = featureToDraft(raw, minMag, opts);
    if (typeof draft === 'string') {
      if (draft !== 'below-min-magnitude') rejected.push({ index, reason: draft });
      return;
    }
    if (seen.has(draft.externalId)) {
      rejected.push({ index, reason: `duplicate id ${draft.externalId}` });
      return;
    }
    seen.add(draft.externalId);
    observations.push(buildObservation(USGS_MANIFEST, opts.receivedAt, draft));
  });

  const generated = epochToIso(collection.metadata?.generated, 'ms');
  return { observations, total: features.length, rejected, ...(generated ? { generatedAt: generated } : {}) };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function text(v: unknown, max = 300): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

export function featureToDraft(raw: unknown, minMag: number, opts: NormalizeOptions): ObservationDraft | string {
  if (!raw || typeof raw !== 'object') return 'feature not an object';
  const f = raw as UsgsFeature;
  const p = f.properties;
  if (!p || typeof p !== 'object') return 'missing properties';
  const coords =
    f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : undefined;
  if (!coords) return 'missing point geometry';
  const [lon, lat, depthKm] = coords as unknown[];
  if (!isValidLatLon(lat, lon)) return 'invalid coordinates';
  if (depthKm !== undefined && depthKm !== null && (typeof depthKm !== 'number' || !Number.isFinite(depthKm)))
    return 'invalid depth';
  const mag = p['mag'];
  if (mag !== null && mag !== undefined && (typeof mag !== 'number' || !Number.isFinite(mag) || mag > 10 || mag < -5))
    return 'invalid magnitude';
  const magnitude = typeof mag === 'number' ? mag : undefined;
  if (magnitude !== undefined && magnitude < minMag) return 'below-min-magnitude';
  if (magnitude === undefined && minMag > Number.NEGATIVE_INFINITY) return 'below-min-magnitude';
  const time = epochToIso(p['time'], 'ms');
  if (!time) return 'invalid time';
  const idRaw = f.id ?? p['code'];
  const externalId = idRaw === null || idRaw === undefined || idRaw === '' ? undefined : String(idRaw);
  if (!externalId || !/^[A-Za-z0-9._:-]{1,64}$/.test(externalId)) return 'invalid id';

  const payload: Record<string, JsonValue> = {};
  if (magnitude !== undefined) payload['magnitude'] = magnitude;
  const magType = text(p['magType'], 8)?.toLowerCase();
  if (magType && MAG_TYPES.has(magType)) payload['magType'] = magType;
  if (typeof depthKm === 'number') payload['depthKm'] = depthKm;
  const place = text(p['place']);
  if (place) payload['place'] = place;
  const title = text(p['title']);
  if (title) payload['title'] = title;
  const status = text(p['status'], 16);
  if (status) payload['status'] = status;
  const type = text(p['type'], 32);
  if (type) payload['eventType'] = type;
  const alert = text(p['alert'], 8);
  if (alert) payload['alert'] = alert;
  const tsunami = num(p['tsunami']);
  if (tsunami !== undefined) payload['tsunami'] = tsunami === 1;
  const sig = num(p['sig']);
  if (sig !== undefined) payload['significance'] = sig;
  const felt = num(p['felt']);
  if (felt !== undefined) payload['felt'] = felt;
  const cdi = num(p['cdi']);
  if (cdi !== undefined) payload['cdi'] = cdi;
  const mmi = num(p['mmi']);
  if (mmi !== undefined) payload['mmi'] = mmi;
  const nst = num(p['nst']);
  if (nst !== undefined) payload['stations'] = nst;
  const gap = num(p['gap']);
  if (gap !== undefined) payload['gap'] = gap;
  const rms = num(p['rms']);
  if (rms !== undefined) payload['rms'] = rms;
  const dmin = num(p['dmin']);
  if (dmin !== undefined) payload['dmin'] = dmin;
  const net = text(p['net'], 8);
  if (net) payload['network'] = net;
  const updated = epochToIso(p['updated'], 'ms');
  if (updated) payload['updatedAt'] = updated;
  const url = text(p['url'], 500);
  if (url && /^https:\/\/earthquake\.usgs\.gov\//.test(url)) payload['detailUrl'] = url;
  const ids = text(p['ids'], 500);
  if (ids) payload['aliases'] = ids.split(',').filter(Boolean);

  const flags: string[] = [];
  if (status === 'automatic') flags.push('automatic');
  if (type && type !== 'earthquake') flags.push(`event-type:${type}`);

  const draft: ObservationDraft = {
    externalId,
    objectType: 'earthquake',
    observedAt: time,
    position: {
      latitude: lat as number,
      longitude: lon as number,
      ...(typeof depthKm === 'number' ? { altitudeM: -depthKm * 1000, altitudeDatum: 'msl' as const } : {}),
    },
    payload,
    quality: { complete: true, sourceQuality: 'authoritative', ...(flags.length ? { flags } : {}) },
    origin: opts.origin ?? 'live',
  };
  if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
  if (opts.hash) draft.rawPayloadHash = opts.hash(stableStringify(raw as JsonValue));
  return draft;
}
