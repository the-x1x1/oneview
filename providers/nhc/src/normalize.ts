import type { JsonValue, Observation } from '@worldview/world-model';
import { buildObservation, type ObservationDraft } from '@worldview/provider-sdk';
import { NHC_MANIFEST } from './manifest.js';

/**
 * CurrentStorms.json → storm observations.
 *
 * A storm is admitted with an NHC storm id (basin, number, year: `ep162026`), a position and a
 * `lastUpdate` time that is not in the future; anything else is refused with a reason. Units
 * are the file's own, named in the keys: intensity in knots, pressure in millibars, motion in
 * degrees and miles per hour. Links are kept only when they point at www.nhc.noaa.gov.
 */
export interface NormalizeOptions {
  receivedAt: string;
  nowMs: number;
  origin?: 'live' | 'cached';
  sourceRef?: string;
  hash?: (s: string) => string;
}

export interface NormalizeResult {
  observations: Observation[];
  total: number;
  rejected: Array<{ index: number; reason: string }>;
}

const STORM_ID = /^(al|ep|cp)\d{6}$/;
const FUTURE_SKEW_MS = 10 * 60_000;

/** NHC classification codes (CurrentStorms.json `classification`). */
export const CLASSIFICATIONS: Readonly<Record<string, string>> = Object.freeze({
  TD: 'Tropical Depression',
  TS: 'Tropical Storm',
  HU: 'Hurricane',
  STD: 'Subtropical Depression',
  STS: 'Subtropical Storm',
  PTC: 'Post-Tropical Cyclone',
  PC: 'Potential Tropical Cyclone',
  TY: 'Typhoon',
});

const BASINS: Readonly<Record<string, string>> = Object.freeze({
  al: 'Atlantic',
  ep: 'Eastern Pacific',
  cp: 'Central Pacific',
});

export function normalizeCurrentStorms(payload: unknown, opts: NormalizeOptions): NormalizeResult {
  const root = payload as { activeStorms?: unknown } | null;
  if (!root || typeof root !== 'object' || !Array.isArray(root.activeStorms))
    return {
      observations: [],
      total: 0,
      rejected: [{ index: -1, reason: 'not a CurrentStorms file (no activeStorms)' }],
    };
  const observations: Observation[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  root.activeStorms.forEach((raw, index) => {
    const draft = stormToDraft(raw, opts);
    if (typeof draft === 'string') {
      rejected.push({ index, reason: draft });
      return;
    }
    if (seen.has(draft.externalId)) {
      rejected.push({ index, reason: `duplicate storm ${draft.externalId}` });
      return;
    }
    seen.add(draft.externalId);
    observations.push(buildObservation(NHC_MANIFEST, opts.receivedAt, draft));
  });
  return { observations, total: root.activeStorms.length, rejected };
}

function text(v: unknown, max = 120): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** "15.5N" / "129.0W" → signed degrees. */
export function parseHemisphere(v: unknown, positive: 'N' | 'E', negative: 'S' | 'W'): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^\s*(\d{1,3}(?:\.\d+)?)\s*([NSEW])\s*$/i.exec(v);
  if (!m) return undefined;
  const h = m[2]!.toUpperCase();
  if (h !== positive && h !== negative) return undefined;
  return h === negative ? -Number(m[1]) : Number(m[1]);
}

function iso(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function nhcLink(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === 'www.nhc.noaa.gov' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function stormToDraft(raw: unknown, opts: NormalizeOptions): ObservationDraft | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
  const s = raw as Record<string, unknown>;
  const id = text(s['id'], 16)?.toLowerCase();
  if (!id || !STORM_ID.test(id)) return 'missing or invalid storm id';
  const lat = num(s['latitudeNumeric']) ?? parseHemisphere(s['latitude'], 'N', 'S');
  const lon = num(s['longitudeNumeric']) ?? parseHemisphere(s['longitude'], 'E', 'W');
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return 'invalid position';
  const updated = iso(s['lastUpdate']);
  if (!updated) return 'missing or invalid lastUpdate';
  if (Date.parse(updated) > opts.nowMs + FUTURE_SKEW_MS) return 'lastUpdate in the future';

  const classification = text(s['classification'], 8)?.toUpperCase();
  const name = text(s['name'], 40) ?? id.toUpperCase();
  const payload: Record<string, JsonValue> = {
    name,
    stormId: id,
    basin: BASINS[id.slice(0, 2)]!,
  };
  if (classification) {
    payload['classification'] = classification;
    payload['classificationLabel'] = CLASSIFICATIONS[classification] ?? classification;
  }
  const kt = num(s['intensity']);
  if (kt !== undefined && kt >= 0 && kt < 250) payload['intensityKt'] = kt;
  const mb = num(s['pressure']);
  if (mb !== undefined && mb > 800 && mb < 1100) payload['pressureMb'] = mb;
  const dir = num(s['movementDir']);
  if (dir !== undefined && dir >= 0 && dir <= 360) payload['movementDirDeg'] = dir;
  const mph = num(s['movementSpeed']);
  if (mph !== undefined && mph >= 0 && mph < 200) payload['movementSpeedMph'] = mph;
  const bin = text(s['binNumber'], 8);
  if (bin) payload['binNumber'] = bin;
  const advisory =
    s['publicAdvisory'] && typeof s['publicAdvisory'] === 'object'
      ? (s['publicAdvisory'] as Record<string, unknown>)
      : {};
  const advNum = text(advisory['advNum'], 8);
  if (advNum) payload['advisoryNumber'] = advNum;
  const issued = iso(advisory['issuance']);
  if (issued) payload['advisoryIssuedAt'] = issued;
  const advisoryUrl = nhcLink(advisory['url']);
  if (advisoryUrl) payload['advisoryUrl'] = advisoryUrl;
  const graphics =
    s['forecastGraphics'] && typeof s['forecastGraphics'] === 'object'
      ? (s['forecastGraphics'] as Record<string, unknown>)
      : {};
  const graphicsUrl = nhcLink(graphics['url']);
  if (graphicsUrl) payload['graphicsUrl'] = graphicsUrl;

  const draft: ObservationDraft = {
    externalId: id,
    objectType: 'storm',
    observedAt: updated,
    position: { latitude: lat, longitude: lon },
    payload,
    quality: { complete: kt !== undefined, sourceQuality: 'authoritative' },
    origin: opts.origin ?? 'live',
  };
  if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
  if (opts.hash) draft.rawPayloadHash = opts.hash(JSON.stringify(raw));
  return draft;
}
