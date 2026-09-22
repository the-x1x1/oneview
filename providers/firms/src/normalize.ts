import { stableStringify, type JsonValue, type Observation } from '@worldview/world-model';
import { buildObservation, type ObservationDraft } from '@worldview/provider-sdk';
import { FIRMS_MANIFEST, type FirmsSource } from './manifest.js';
import { acquisitionMsUtc, type FirmsRow } from './csv.js';

export type FireConfidence = 'low' | 'nominal' | 'high';

export interface NormalizeOptions {
  receivedAt: string;
  source: FirmsSource;
  hash?: (input: string) => string;
  origin?: 'live' | 'cached' | 'historical' | 'recorded';
  sourceRef?: string;
}

export interface NormalizeResult {
  observations: Observation[];
  total: number;
  rejected: Array<{ index: number; reason: string }>;
}

/** Nominal pixel footprint at nadir, used as the provider-estimated position accuracy. */
const PIXEL_ACCURACY_M: Record<string, number> = { VIIRS: 375, MODIS: 1000 };

/**
 * VIIRS publishes categorical confidence (l/n/h); MODIS a 0-100 percentage
 * (FIRMS docs: 0-29 low, 30-79 nominal, 80-100 high). Both map to one enum.
 */
export function normalizeConfidence(raw: string): FireConfidence | undefined {
  const v = raw.trim().toLowerCase();
  if (v === 'l' || v === 'low') return 'low';
  if (v === 'n' || v === 'nominal') return 'nominal';
  if (v === 'h' || v === 'high') return 'high';
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n < 0 || n > 100) return undefined;
    return n < 30 ? 'low' : n < 80 ? 'nominal' : 'high';
  }
  return undefined;
}

/** Deterministic id: one detection = one source pixel at one acquisition minute. */
export function detectionExternalId(
  source: string,
  row: Pick<FirmsRow, 'acqDate' | 'acqTime' | 'latitude' | 'longitude'>,
): string {
  return `${source}:${row.acqDate}T${String(row.acqTime).padStart(4, '0')}:${row.latitude}:${row.longitude}`;
}

export function normalizeFirmsRows(rows: FirmsRow[], opts: NormalizeOptions): NormalizeResult {
  const observations: Observation[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const draft = rowToDraft(row, opts);
    if (typeof draft === 'string') {
      rejected.push({ index, reason: draft });
      return;
    }
    if (seen.has(draft.externalId)) {
      rejected.push({ index, reason: `duplicate detection ${draft.externalId}` });
      return;
    }
    seen.add(draft.externalId);
    observations.push(buildObservation(FIRMS_MANIFEST, opts.receivedAt, draft));
  });
  return { observations, total: rows.length, rejected };
}

export function rowToDraft(row: FirmsRow, opts: NormalizeOptions): ObservationDraft | string {
  const acquiredMs = acquisitionMsUtc(row.acqDate, row.acqTime);
  if (!Number.isFinite(acquiredMs)) return 'invalid acquisition time';
  const confidence = normalizeConfidence(row.confidence);
  if (!confidence) return `unknown confidence value "${row.confidence.slice(0, 8)}"`;
  const instrument = row.instrument.toUpperCase();
  const dayNight =
    row.daynight.toUpperCase() === 'D' ? 'day' : row.daynight.toUpperCase() === 'N' ? 'night' : undefined;

  const payload: Record<string, JsonValue> = {
    confidence,
    source: opts.source,
    satellite: row.satellite,
    instrument: row.instrument,
  };
  if (row.brightness !== undefined) payload['brightnessK'] = row.brightness;
  if (row.brightnessSecondary !== undefined) payload['brightnessSecondaryK'] = row.brightnessSecondary;
  if (row.frp !== undefined) payload['frpMw'] = row.frp;
  if (row.scan !== undefined) payload['scanKm'] = row.scan;
  if (row.track !== undefined) payload['trackKm'] = row.track;
  if (dayNight) payload['dayNight'] = dayNight;
  if (row.version) payload['version'] = row.version;
  payload['confidenceRaw'] = row.confidence;

  const flags: string[] = [];
  if (confidence === 'low') flags.push('low-confidence');
  if (dayNight === 'day' && confidence !== 'high') flags.push('daytime-detection');

  const draft: ObservationDraft = {
    externalId: detectionExternalId(opts.source, row),
    objectType: 'fire-detection',
    observedAt: new Date(acquiredMs).toISOString(),
    position: { latitude: row.latitude, longitude: row.longitude },
    payload,
    quality: {
      complete: true,
      sourceQuality: 'authoritative',
      ...(PIXEL_ACCURACY_M[instrument] !== undefined ? { positionAccuracyM: PIXEL_ACCURACY_M[instrument]! } : {}),
      ...(flags.length ? { flags } : {}),
    },
    origin: opts.origin ?? 'live',
  };
  if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
  if (opts.hash) draft.rawPayloadHash = opts.hash(stableStringify(rowToJson(row)));
  return draft;
}

function rowToJson(row: FirmsRow): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
  return out;
}
