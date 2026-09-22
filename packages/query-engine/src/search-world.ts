import {
  haversineMeters,
  stableStringify,
  type GeoPosition,
  type JsonValue,
  type WorldObject,
} from '@worldview/world-model';
import type { WorldState } from '@worldview/state-engine';
import type { SearchResult } from '@worldview/ipc-contract';
import { executeQuery, type EventSource } from './execute.js';
import type { Gazetteer } from './gazetteer.js';
import { stableHash } from './hash.js';
import { parseSearch, type SearchIntent } from './parse-search.js';
import { tokenize } from './text-match.js';
import { DEFAULT_COMMANDS, STOP_WORDS, type CommandDefinition } from './vocabulary.js';
import { geometryRepresentativePoint } from './geometry.js';

/**
 * searchWorld — merges parser intents into ranked SearchResults (ipc-contract shape).
 * Scores are deterministic in [0, 1]; a `bias` position adds a small proximity bonus
 * (≤ 0.05) so nearby places/objects win ties. See docs/architecture/SEARCH-GRAMMAR.md.
 */
export interface SearchWorldOptions {
  state: WorldState;
  gazetteer: Gazetteer;
  commands?: readonly CommandDefinition[];
  now(): number;
  bias?: GeoPosition;
  limit?: number;
  /** Optional event source for `kind: 'event'` results. */
  events?: EventSource;
  /** Max live-state objects scanned for label/id prefix matches (default 200 000). */
  scanLimit?: number;
}

const KIND_RANK: Record<SearchResult['kind'], number> = { object: 0, place: 1, query: 2, event: 3, command: 4 };
const LABEL_KEYS = ['name', 'callsign', 'registration', 'flight', 'title', 'place', 'label', 'shortName'] as const;

export function searchWorld(text: string, opts: SearchWorldOptions): SearchResult[] {
  const parsed = parseSearch(text, {
    gazetteer: opts.gazetteer,
    now: opts.now,
    commands: opts.commands ?? DEFAULT_COMMANDS,
  });
  const results = new Map<string, SearchResult>();
  const add = (r: SearchResult) => {
    const prev = results.get(r.id);
    if (!prev || r.score > prev.score) results.set(r.id, r);
  };

  for (const intent of parsed.intents) {
    switch (intent.kind) {
      case 'place':
        add(placeResult(intent, opts.bias));
        break;
      case 'object':
        for (const r of objectHintResults(intent, opts.state)) add(r);
        break;
      case 'query':
        for (const r of queryResults(intent, opts)) add(r);
        break;
      case 'command':
        add(commandResult(intent));
        break;
    }
  }

  // Live-state matches by id / label prefix for the free-text part.
  const free = freeTextOf(parsed.intents, parsed.text);
  if (free) {
    for (const r of scanState(opts.state, free, opts.bias, opts.scanLimit ?? 200_000, (opts.limit ?? 20) * 2)) add(r);
    if (opts.events) for (const r of scanEvents(opts.events, free, opts.limit ?? 20)) add(r);
  }

  const out = [...results.values()];
  out.sort(
    (a, b) => b.score - a.score || KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out.slice(0, opts.limit ?? 20);
}

/** The part of the search that stays free text: the query intent's `text`, or the whole input when nothing structured parsed. */
function freeTextOf(intents: readonly SearchIntent[], text: string): string | undefined {
  for (const i of intents) if (i.kind === 'query' && i.query?.text) return i.query.text;
  return intents.some((i) => i.kind !== 'command') ? undefined : text;
}

function biasBonus(bias: GeoPosition | undefined, p: GeoPosition | undefined): number {
  if (!bias || !p) return 0;
  const d = haversineMeters(bias, p);
  if (d <= 100_000) return 0.05;
  if (d <= 500_000) return 0.03;
  if (d <= 2_000_000) return 0.01;
  return 0;
}

function clamp(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
}

function placeResult(intent: SearchIntent, bias: GeoPosition | undefined): SearchResult {
  const hit = intent.place!;
  const subtitle =
    hit.kind === 'coordinate'
      ? 'Coordinates'
      : `${capitalize(hit.kind)}${hit.countryCode ? ` · ${hit.countryCode}` : ''}`;
  return {
    kind: 'place',
    id: hit.id,
    title: hit.name,
    subtitle,
    position: hit.position,
    ...(hit.bounds ? { bounds: hit.bounds } : {}),
    source: hit.kind === 'coordinate' ? 'parser' : 'local-index',
    score: clamp(0.5 + 0.45 * hit.score + biasBonus(bias, hit.position)),
  };
}

function objectHintResults(intent: SearchIntent, state: WorldState): SearchResult[] {
  const hint = intent.objectHint!;
  return hint.idCandidates.map((id) => {
    const obj = state.get(id);
    if (obj) return objectResult(obj, 0.97, 0);
    return {
      kind: 'object',
      id,
      title: intent.title,
      subtitle: `${capitalize(hint.type)} · not in live state`,
      source: 'world-state',
      score: intent.confidence === 'HIGH' ? 0.75 : intent.confidence === 'MEDIUM' ? 0.6 : 0.45,
    } satisfies SearchResult;
  });
}

function objectResult(obj: WorldObject, base: number, bonus: number): SearchResult {
  const title =
    obj.labels['name'] ??
    obj.labels['callsign'] ??
    obj.labels['title'] ??
    obj.labels['registration'] ??
    obj.id.slice(obj.id.lastIndexOf(':') + 1);
  const parts = [
    capitalize(obj.type),
    obj.labels['callsign'] && title !== obj.labels['callsign'] ? obj.labels['callsign'] : undefined,
    obj.labels['place'],
  ].filter((x): x is string => Boolean(x));
  return {
    kind: 'object',
    id: obj.id,
    title,
    subtitle: parts.join(' · '),
    ...(obj.position ? { position: obj.position } : {}),
    source: 'world-state',
    score: clamp(base + bonus),
  };
}

/** A query result with its live count; label lookups (e.g. a callsign filter) also surface the matching objects themselves. */
function queryResults(intent: SearchIntent, opts: SearchWorldOptions): SearchResult[] {
  const query = intent.query!;
  const lookup = query.filters?.some((f) => f.field.startsWith('labels.')) ?? false;
  const result = executeQuery({ ...query, limit: lookup ? 5 : 1 }, { state: opts.state, now: opts.now });
  const base = intent.confidence === 'HIGH' ? 0.9 : intent.confidence === 'MEDIUM' ? 0.7 : 0.45;
  const id = `query:${stableHash(stableStringify(query as unknown as JsonValue))}`;
  const centre = query.region ? regionPosition(query.region) : undefined;
  const out: SearchResult[] = [
    {
      kind: 'query',
      id,
      title: `${intent.title} (${result.total})`,
      subtitle: describeQuery(query),
      query,
      source: 'parser',
      score: clamp(base),
      ...(centre ? { position: centre } : {}),
      ...(query.region?.kind === 'bounds' ? { bounds: query.region.bounds } : {}),
    },
  ];
  if (lookup) for (const obj of result.items) out.push(objectResult(obj, 0.95, biasBonus(opts.bias, obj.position)));
  return out;
}

function regionPosition(region: NonNullable<SearchIntent['query']>['region']): GeoPosition | undefined {
  if (!region) return undefined;
  if (region.kind === 'circle') return region.center;
  if (region.kind === 'bounds' || (region.kind === 'admin' && region.bounds)) {
    const b = region.bounds!;
    return { latitude: (b.south + b.north) / 2, longitude: (b.west + b.east) / 2 };
  }
  if (region.kind === 'polygon') {
    const n = region.polygon.length;
    if (!n) return undefined;
    let lat = 0,
      lon = 0;
    for (const [x, y] of region.polygon) {
      lon += x;
      lat += y;
    }
    return { latitude: lat / n, longitude: lon / n };
  }
  return undefined;
}

function describeQuery(q: NonNullable<SearchIntent['query']>): string {
  const bits: string[] = [];
  if (q.objectTypes?.length) bits.push(q.objectTypes.join(', '));
  if (q.filters?.length) bits.push(q.filters.map((f) => `${f.field} ${f.op} ${JSON.stringify(f.value)}`).join('; '));
  if (q.region)
    bits.push(q.region.kind === 'circle' ? `${Math.round(q.region.radiusM / 1000)} km radius` : q.region.kind);
  if (q.time) bits.push(`${q.time.start.slice(0, 16)}Z → ${q.time.end.slice(0, 16)}Z`);
  if (q.text) bits.push(`text "${q.text}"`);
  return bits.join(' · ') || 'Query';
}

function commandResult(intent: SearchIntent): SearchResult {
  const base = intent.confidence === 'HIGH' ? 0.9 : intent.confidence === 'MEDIUM' ? 0.73 : 0.5;
  return {
    kind: 'command',
    id: `command:${intent.command!}`,
    title: intent.title,
    subtitle: 'Command',
    source: 'command',
    score: clamp(base),
  };
}

function scanState(
  state: WorldState,
  text: string,
  bias: GeoPosition | undefined,
  scanLimit: number,
  keep: number,
): SearchResult[] {
  const tokens = tokenize(text).filter((t) => !STOP_WORDS.has(t) && t.length >= 2);
  if (tokens.length === 0) return [];
  const found: Array<{ r: SearchResult }> = [];
  let scanned = 0;
  for (const obj of state.all()) {
    if (++scanned > scanLimit) break;
    const score = matchScore(obj, tokens);
    if (score <= 0) continue;
    found.push({ r: objectResult(obj, score, biasBonus(bias, obj.position)) });
  }
  found.sort((a, b) => b.r.score - a.r.score || (a.r.id < b.r.id ? -1 : 1));
  return found.slice(0, keep).map((f) => f.r);
}

/** 0.9 exact label; 0.8 label prefix; 0.7 id-value prefix; 0.6 label word prefix; 0 otherwise. Every token must match. */
function matchScore(obj: WorldObject, tokens: string[]): number {
  const idValue = obj.id.slice(obj.id.lastIndexOf(':') + 1).toLowerCase();
  const labels: string[] = [];
  for (const k of LABEL_KEYS) {
    const v = obj.labels[k];
    if (v) labels.push(v.toLowerCase());
  }
  let worst = 1;
  for (const t of tokens) {
    let best = 0;
    for (const l of labels) {
      if (l === t) {
        best = Math.max(best, 0.9);
        break;
      }
      if (l.startsWith(t)) best = Math.max(best, 0.8);
      else if (l.split(/\s+/).some((w) => w.startsWith(t))) best = Math.max(best, 0.6);
    }
    if (idValue === t) best = Math.max(best, 0.85);
    else if (idValue.startsWith(t)) best = Math.max(best, 0.7);
    if (best === 0) return 0;
    worst = Math.min(worst, best);
  }
  return worst;
}

function scanEvents(events: EventSource, text: string, keep: number): SearchResult[] {
  const tokens = tokenize(text).filter((t) => !STOP_WORDS.has(t) && t.length >= 2);
  if (tokens.length === 0) return [];
  const out: SearchResult[] = [];
  for (const e of events.all()) {
    const title = e.title.toLowerCase();
    if (!tokens.every((t) => title.split(/\s+/).some((w) => w.startsWith(t)))) continue;
    const p = e.geometry ? geometryRepresentativePoint(e.geometry) : undefined;
    out.push({
      kind: 'event',
      id: e.id,
      title: e.title,
      subtitle: `${capitalize(e.type)}${e.severity ? ` · ${e.severity}` : ''}`,
      ...(p ? { position: p } : {}),
      source: 'world-state',
      score: 0.6,
    });
    if (out.length >= keep) break;
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');
}
