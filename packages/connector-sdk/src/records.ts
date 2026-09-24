import type { JsonValue, Observation } from '@worldview/world-model';
import { buildObservation, type ObservationDraft, type ProviderManifest } from '@worldview/provider-sdk';
import type { ConnectorProviderDefinition } from './definition.js';
import { mapRecord, type CompiledMapping } from './mapping.js';
import { readPath } from './path.js';

/**
 * From a response body to observations: find the records (`response.itemsPath`), map each
 * one (mapping.ts), build the observation the provider SDK builds for everyone. Rejections
 * are counted with a reason and a sample kept, so `rejected records` in the log says what
 * the source sent rather than only that it was wrong.
 */
export interface RecordsResult {
  observations: Observation[];
  /** Records seen (before filtering and rejection). */
  total: number;
  /** Records the definition's filter left out. */
  filtered: number;
  rejected: Array<{ index: number; reason: string }>;
  /** The body did not have the shape `response` describes. */
  malformed?: string;
}

export interface MapRecordsOptions {
  manifest: ProviderManifest;
  definition: ConnectorProviderDefinition;
  mapping: CompiledMapping;
  /** ISO time of the fetch: receivedAt, and observedAt for records that carry no time. */
  receivedAt: string;
  origin: 'live' | 'cached';
  sourceRef: string;
  hash?: (s: string) => string;
  /** Records per response, at most (the rest are counted as rejected). */
  maxRecords?: number;
}

export const MAX_RECORDS = 50_000;
const FUTURE_SKEW_MS = 10 * 60_000;

/** The records in a body, by `response.itemsPath` / `itemsAs`. */
export function extractRecords(
  body: unknown,
  response: ConnectorProviderDefinition['response'] | undefined,
): { records: unknown[] } | { malformed: string } {
  const at = response?.itemsPath ? readPath(body, response.itemsPath) : (body as JsonValue | undefined);
  if (at === undefined || at === null) return { malformed: `nothing at ${response?.itemsPath ?? 'the body'}` };
  if (response?.itemsAs === 'entries') {
    if (typeof at !== 'object' || Array.isArray(at))
      return { malformed: `${response.itemsPath ?? 'the body'} is not an object of entries` };
    return {
      records: Object.entries(at).map(([key, value]) =>
        value && typeof value === 'object' && !Array.isArray(value) ? { _key: key, ...value } : { _key: key, value },
      ),
    };
  }
  if (Array.isArray(at)) return { records: at };
  if (typeof at === 'object') return { records: [at] };
  return { malformed: `${response?.itemsPath ?? 'the body'} is a ${typeof at}, not records` };
}

export function mapRecords(records: unknown[], opts: MapRecordsOptions): Omit<RecordsResult, 'malformed'> {
  const observations: Observation[] = [];
  const rejected: RecordsResult['rejected'] = [];
  const seen = new Set<string>();
  let filtered = 0;
  const max = opts.maxRecords ?? MAX_RECORDS;
  const receivedMs = Date.parse(opts.receivedAt);
  const quality = opts.definition.sourceQuality ?? 'unknown';
  records.forEach((raw, index) => {
    if (index >= max) {
      if (index === max) rejected.push({ index, reason: `more than ${max} records; the rest are dropped` });
      return;
    }
    const r = mapRecord(raw, opts.mapping);
    if (!r.ok) {
      if ('skipped' in r) filtered++;
      else rejected.push({ index, reason: r.reason });
      return;
    }
    const rec = r.record;
    if (!rec.position && !rec.geometry) {
      rejected.push({ index, reason: 'no position' });
      return;
    }
    if (seen.has(rec.externalId)) {
      rejected.push({ index, reason: `duplicate id ${rec.externalId.slice(0, 40)}` });
      return;
    }
    seen.add(rec.externalId);
    const flags: string[] = [];
    let observedAt = rec.observedAt;
    if (!observedAt) {
      observedAt = opts.receivedAt;
      flags.push('fetch-time');
    } else if (Date.parse(observedAt) > receivedMs + FUTURE_SKEW_MS) {
      rejected.push({ index, reason: 'observedAt is in the future' });
      return;
    }
    const payload: Record<string, JsonValue> = { ...rec.labels, ...rec.properties };
    const draft: ObservationDraft = {
      externalId: rec.externalId,
      objectType: opts.definition.objectType,
      observedAt,
      payload,
      quality: { complete: true, sourceQuality: quality, ...(flags.length ? { flags } : {}) },
      origin: opts.origin,
      sourceRef: opts.sourceRef,
    };
    if (rec.position) draft.position = rec.position;
    if (rec.geometry) draft.geometry = rec.geometry;
    if (opts.hash && opts.manifest.dataPolicy.rawPayloadRetentionAllowed)
      draft.rawPayloadHash = opts.hash(JSON.stringify(raw));
    observations.push(buildObservation(opts.manifest, opts.receivedAt, draft));
  });
  return { observations, total: records.length, filtered, rejected };
}

/** Both steps, from a body. */
export function bodyToObservations(body: unknown, opts: MapRecordsOptions): RecordsResult {
  const found = extractRecords(body, opts.definition.response);
  if ('malformed' in found)
    return { observations: [], total: 0, filtered: 0, rejected: [], malformed: found.malformed };
  return mapRecords(found.records, opts);
}
