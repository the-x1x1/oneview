import { ObjectTypes, type GeoRegion, type TimeRange, type WorldFilter, type WorldQuery } from '@worldview/world-model';
import { parseCoordinates } from './coordinates.js';
import type { Gazetteer, GazetteerHit, PlaceKind } from './gazetteer.js';
import { DEFAULT_COMMANDS, STOP_WORDS, TYPE_VOCABULARY, typeLabel, type CommandDefinition } from './vocabulary.js';

/**
 * Deterministic search grammar (ADR-010). No LLM. See docs/architecture/SEARCH-GRAMMAR.md.
 *
 *   text → [coordinates] | tokens → time phrases → thresholds → identifiers → object types
 *        → spatial phrase (preposition + place) → leftover place / free text → commands
 */
export type IntentConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface SearchIntent {
  kind: 'query' | 'place' | 'object' | 'command';
  confidence: IntentConfidence;
  /** Human title, e.g. "Earthquakes near Japan". */
  title: string;
  query?: WorldQuery;
  place?: GazetteerHit;
  objectHint?: { type: string; idCandidates: string[] };
  command?: string;
}

export interface ParsedSearch {
  text: string;
  intents: SearchIntent[];
  /** Explanations for things the grammar recognised but could not act on (e.g. MGRS). */
  notes: string[];
}

export interface ParseContext {
  gazetteer: Gazetteer;
  now(): number;
  /** Command catalogue; defaults to DEFAULT_COMMANDS. Pass [] to disable command intents. */
  commands?: readonly CommandDefinition[];
}

interface Token {
  text: string;
  lower: string;
  used: boolean;
}

interface Draft {
  types: string[];
  filters: WorldFilter[];
  filterText: string[];
  region?: GeoRegion;
  regionText?: string;
  time?: TimeRange;
  timeText?: string;
  freeText?: string;
  spatialUnresolved?: string;
}

const HOUR = 3_600_000,
  DAY = 86_400_000;
export const ISS_NORAD_ID = 'satellite:norad:25544';

/** Radius (metres) used for "near <place>" by place kind. */
export const NEAR_RADIUS_M: Readonly<Record<PlaceKind, number>> = Object.freeze({
  city: 100_000,
  region: 500_000,
  country: 1_000_000,
  island: 100_000,
  airport: 50_000,
  port: 50_000,
  poi: 25_000,
  coordinate: 50_000,
});

export function parseSearch(text: string, ctx: ParseContext): ParsedSearch {
  const raw = text.replace(/\s+/g, ' ').trim();
  const out: ParsedSearch = { text: raw, intents: [], notes: [] };
  if (!raw) return out;

  const coord = parseCoordinates(raw.replace(NAV_PREFIX, ''));
  if (coord) {
    if (coord.kind === 'unsupported') {
      out.notes.push(coord.note);
      return out;
    }
    out.intents.push({
      kind: 'place',
      confidence: 'HIGH',
      title: coord.label,
      place: {
        id: `coordinate:${coord.latitude.toFixed(5)},${coord.longitude.toFixed(5)}`,
        name: coord.label,
        kind: 'coordinate',
        position: { latitude: coord.latitude, longitude: coord.longitude },
        score: 1,
        source: 'parser',
      },
    });
    return out;
  }

  const tokens: Token[] = raw
    .split(' ')
    .map((t) => ({ text: t, lower: t.toLowerCase().replace(/[.,;!?]+$/g, ''), used: false }));
  const draft: Draft = { types: [], filters: [], filterText: [] };
  const now = ctx.now();

  extractNavigation(tokens);
  extractTime(tokens, now, draft);
  extractIdentifiers(tokens, out, ctx);
  extractTypes(tokens, draft);
  extractThresholds(tokens, draft, out);
  extractSpatial(tokens, ctx.gazetteer, draft, out);
  extractLeftover(tokens, ctx.gazetteer, draft, out);

  if (draft.types.length || draft.filters.length || draft.region || draft.time || draft.freeText) {
    const query = buildQuery(draft);
    const confidence: IntentConfidence = draft.types.length
      ? draft.spatialUnresolved
        ? 'MEDIUM'
        : 'HIGH'
      : draft.filters.length || draft.region
        ? 'MEDIUM'
        : 'LOW';
    out.intents.push({ kind: 'query', confidence, title: buildTitle(draft), query });
  }

  for (const c of matchCommands(raw, ctx.commands ?? DEFAULT_COMMANDS)) {
    out.intents.push({
      kind: 'command',
      confidence: c.score >= 0.9 ? 'HIGH' : c.score >= 0.6 ? 'MEDIUM' : 'LOW',
      title: c.command.title,
      command: c.command.id,
    });
  }
  return out;
}

// ---- navigation ----------------------------------------------------------------

const NAV_VERBS = new Set(['fly', 'jump', 'zoom', 'navigate', 'goto']);
/** The same phrases on the raw text, for coordinates ("fly to 21.3, -157.9"), which are parsed before tokens. */
const NAV_PREFIX = /^(?:take me to|go to|(?:fly|jump|zoom|navigate|goto)(?:\s+(?:to|over|into|onto))?)\s+(?=\S)/i;
const NAV_PREPOSITIONS = new Set(['to', 'over', 'into', 'onto']);

/**
 * "fly to Honolulu", "go to PHNL", "take me to Tokyo", "zoom to 21.3, -157.9": the words that
 * say *go there* are consumed so the place is what is left to resolve. Without this, "fly
 * to Honolulu" was a free-text search for objects labelled "fly Honolulu" and found nothing
 * — while the Go to location command's own hint suggested typing exactly that. The verb is
 * only taken when something follows it: "fly" alone may be the start of a name.
 */
function extractNavigation(tokens: Token[]): void {
  let i = 0;
  const at = (k: number) => tokens[k]?.lower;
  if (at(0) === 'take' && at(1) === 'me' && at(2) === 'to') i = 3;
  else if (at(0) === 'go' && at(1) === 'to') i = 2;
  else if (NAV_VERBS.has(at(0) ?? '')) i = NAV_PREPOSITIONS.has(at(1) ?? '') ? 2 : 1;
  if (i === 0 || i >= tokens.length) return;
  for (let k = 0; k < i; k++) tokens[k]!.used = true;
}

// ---- time --------------------------------------------------------------------

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  m: 60_000,
  hour: HOUR,
  hours: HOUR,
  hr: HOUR,
  hrs: HOUR,
  h: HOUR,
  day: DAY,
  days: DAY,
  d: DAY,
  week: 7 * DAY,
  weeks: 7 * DAY,
  w: 7 * DAY,
  month: 30 * DAY,
  months: 30 * DAY,
};
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  ten: 10,
  twelve: 12,
};

function extractTime(tokens: Token[], now: number, draft: Draft): void {
  const startOfDay = (ms: number) => Math.floor(ms / DAY) * DAY;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.used) continue;
    let range: TimeRange | undefined;
    let label: string | undefined;
    let consumed = 0;
    const a = tokens[i + 1]?.lower,
      b = tokens[i + 2]?.lower;
    if (t.lower === 'today') {
      range = { start: iso(startOfDay(now)), end: iso(now) };
      label = 'today';
      consumed = 1;
    } else if (t.lower === 'yesterday') {
      range = { start: iso(startOfDay(now) - DAY), end: iso(startOfDay(now)) };
      label = 'yesterday';
      consumed = 1;
    } else if (t.lower === 'since' && a === 'yesterday') {
      range = { start: iso(startOfDay(now) - DAY), end: iso(now) };
      label = 'since yesterday';
      consumed = 2;
    } else if (t.lower === 'this' && (a === 'week' || a === 'month')) {
      const start =
        a === 'week' ? startOfIsoWeek(now) : Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
      range = { start: iso(start), end: iso(now) };
      label = `this ${a}`;
      consumed = 2;
    } else if (t.lower === 'last' || t.lower === 'past' || t.lower === 'previous') {
      if (a !== undefined) {
        const n = numberOf(a);
        if (n !== undefined && b !== undefined && UNIT_MS[b] !== undefined) {
          range = lookback(now, n * UNIT_MS[b]!);
          label = `last ${n} ${b}`;
          consumed = 3;
        } else if (n === undefined && UNIT_MS[a] !== undefined && a.length > 1) {
          range = lookback(now, UNIT_MS[a]!);
          label = `last ${a}`;
          consumed = 2;
        } else {
          const m = /^(\d+)(h|d|w|m|hr|hrs|min|mins)$/.exec(a);
          if (m) {
            const unit = UNIT_MS[m[2]!]!;
            range = lookback(now, Number(m[1]) * unit);
            label = `last ${m[1]}${m[2]}`;
            consumed = 2;
          }
        }
      }
    }
    if (!range) continue;
    for (let k = 0; k < consumed; k++) tokens[i + k]!.used = true;
    // Swallow dangling "in the" / "over the" / "during the" / "from the" before the phrase.
    let j = i - 1;
    if (j >= 0 && !tokens[j]!.used && tokens[j]!.lower === 'the') {
      tokens[j]!.used = true;
      j--;
    }
    if (j >= 0 && !tokens[j]!.used && ['in', 'over', 'during', 'from', 'within', 'for'].includes(tokens[j]!.lower))
      tokens[j]!.used = true;
    draft.time = range;
    if (label !== undefined) draft.timeText = label;
    return;
  }
}

function numberOf(word: string): number | undefined {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word];
}
function lookback(now: number, ms: number): TimeRange {
  return { start: iso(now - ms), end: iso(now) };
}
function iso(ms: number): string {
  return new Date(ms).toISOString();
}
function startOfIsoWeek(now: number): number {
  const d = new Date(now);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY;
}

// ---- identifiers -------------------------------------------------------------

const ICAO24_RE = /^[0-9a-f]{6}$/i;
const CALLSIGN_RE = /^[A-Z]{2,3}\d{1,4}[A-Z]?$/i;
const MMSI_RE = /^\d{9}$/;
const NORAD_TOKEN_RE = /^(?:norad|sat|satellite)[:#-]?(\d{1,6})$/i;
const NORAD_WORDS = new Set(['norad', 'sat', 'satellite']);

function extractIdentifiers(tokens: Token[], out: ParsedSearch, ctx: ParseContext): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.used) continue;
    if (t.lower === 'iss') {
      t.used = true;
      out.intents.push({
        kind: 'object',
        confidence: 'HIGH',
        title: 'ISS (International Space Station)',
        objectHint: { type: ObjectTypes.Satellite, idCandidates: [ISS_NORAD_ID] },
      });
      for (const hit of ctx.gazetteer.lookup('ISS', { limit: 3 })) out.intents.push(placeIntent(hit));
      continue;
    }
    const noradSingle = NORAD_TOKEN_RE.exec(t.text);
    if (noradSingle) {
      t.used = true;
      out.intents.push(
        objectIntent(
          ObjectTypes.Satellite,
          [`satellite:norad:${Number(noradSingle[1])}`],
          `Satellite NORAD ${Number(noradSingle[1])}`,
          'HIGH',
        ),
      );
      continue;
    }
    const next = tokens[i + 1];
    if (NORAD_WORDS.has(t.lower) && next && !next.used && /^#?\d{1,6}$/.test(next.text)) {
      t.used = true;
      next.used = true;
      const n = Number(next.text.replace('#', ''));
      out.intents.push(objectIntent(ObjectTypes.Satellite, [`satellite:norad:${n}`], `Satellite NORAD ${n}`, 'HIGH'));
      i++;
      continue;
    }
    if (MMSI_RE.test(t.text)) {
      t.used = true;
      out.intents.push(objectIntent(ObjectTypes.Vessel, [`vessel:mmsi:${t.text}`], `Vessel MMSI ${t.text}`, 'HIGH'));
      continue;
    }
    const hex = ICAO24_RE.test(t.text) && /\d/.test(t.text);
    const callsign = CALLSIGN_RE.test(t.text);
    if (hex) {
      t.used = true;
      out.intents.push(
        objectIntent(
          ObjectTypes.Aircraft,
          [`aircraft:icao24:${t.text.toLowerCase()}`],
          `Aircraft ${t.text.toLowerCase()}`,
          /[a-f]/i.test(t.text) ? 'MEDIUM' : 'LOW',
        ),
      );
    }
    if (callsign) {
      t.used = true;
      const cs = t.text.toUpperCase();
      out.intents.push({
        kind: 'query',
        confidence: 'MEDIUM',
        title: `Aircraft ${cs}`,
        query: { objectTypes: [ObjectTypes.Aircraft], filters: [{ field: 'labels.callsign', op: 'eq', value: cs }] },
      });
    }
  }
}

function objectIntent(type: string, idCandidates: string[], title: string, confidence: IntentConfidence): SearchIntent {
  return { kind: 'object', confidence, title, objectHint: { type, idCandidates } };
}

function placeIntent(hit: GazetteerHit): SearchIntent {
  return {
    kind: 'place',
    confidence: hit.score >= 1 ? 'HIGH' : hit.score >= 0.7 ? 'MEDIUM' : 'LOW',
    title: hit.name,
    place: hit,
  };
}

// ---- object types ------------------------------------------------------------

const PHRASES = TYPE_VOCABULARY.flatMap((v) => v.phrases.map((p) => ({ type: v.type, words: p.split(' ') }))).sort(
  (a, b) => b.words.length - a.words.length,
);

function extractTypes(tokens: Token[], draft: Draft): void {
  for (const phrase of PHRASES) {
    for (let i = 0; i + phrase.words.length <= tokens.length; i++) {
      let ok = true;
      for (let k = 0; k < phrase.words.length; k++) {
        const t = tokens[i + k]!;
        if (t.used || t.lower !== phrase.words[k]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (let k = 0; k < phrase.words.length; k++) tokens[i + k]!.used = true;
      if (!draft.types.includes(phrase.type)) draft.types.push(phrase.type);
    }
  }
}

// ---- thresholds (magnitude / altitude / speed) ----------------------------------

type ThresholdField = 'properties.magnitude' | 'position.altitudeM' | 'motion.speedMps';
const UNIT_TO_FIELD: Record<string, { field: ThresholdField; factor: number; label: string }> = {
  ft: { field: 'position.altitudeM', factor: 0.3048, label: 'ft' },
  feet: { field: 'position.altitudeM', factor: 0.3048, label: 'ft' },
  foot: { field: 'position.altitudeM', factor: 0.3048, label: 'ft' },
  m: { field: 'position.altitudeM', factor: 1, label: 'm' },
  meters: { field: 'position.altitudeM', factor: 1, label: 'm' },
  metres: { field: 'position.altitudeM', factor: 1, label: 'm' },
  km: { field: 'position.altitudeM', factor: 1000, label: 'km' },
  kt: { field: 'motion.speedMps', factor: 0.514444, label: 'kt' },
  kts: { field: 'motion.speedMps', factor: 0.514444, label: 'kt' },
  kn: { field: 'motion.speedMps', factor: 0.514444, label: 'kt' },
  knots: { field: 'motion.speedMps', factor: 0.514444, label: 'kt' },
  mph: { field: 'motion.speedMps', factor: 0.44704, label: 'mph' },
  kph: { field: 'motion.speedMps', factor: 1 / 3.6, label: 'km/h' },
  'km/h': { field: 'motion.speedMps', factor: 1 / 3.6, label: 'km/h' },
  kmh: { field: 'motion.speedMps', factor: 1 / 3.6, label: 'km/h' },
  'm/s': { field: 'motion.speedMps', factor: 1, label: 'm/s' },
  mps: { field: 'motion.speedMps', factor: 1, label: 'm/s' },
};
const GTE_WORDS = new Set(['above', 'over', '>', '>=', '≥', 'gte', 'minimum', 'min']);
const LTE_WORDS = new Set(['below', 'under', '<', '<=', '≤', 'lte', 'maximum', 'max']);

function extractThresholds(tokens: Token[], draft: Draft, out: ParsedSearch): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.used) continue;
    // M5+ / M5.5 / M5
    const mag = /^m(\d+(?:\.\d+)?)\+?$/i.exec(t.lower);
    if (mag) {
      t.used = true;
      if (!draft.types.includes(ObjectTypes.Earthquake)) draft.types.push(ObjectTypes.Earthquake);
      addFilter(draft, 'properties.magnitude', 'gte', Number(mag[1]), `M${mag[1]}+`);
      continue;
    }
    // magnitude [op] N  |  mag N
    if (t.lower === 'magnitude' || t.lower === 'mag') {
      const r = readThreshold(tokens, i + 1);
      if (r) {
        t.used = true;
        for (let k = i + 1; k <= r.end; k++) tokens[k]!.used = true;
        if (!draft.types.includes(ObjectTypes.Earthquake)) draft.types.push(ObjectTypes.Earthquake);
        addFilter(
          draft,
          'properties.magnitude',
          r.op,
          r.value,
          `M${r.value}${r.op === 'gte' ? '+' : r.op === 'lte' ? '-' : ''}`,
        );
        continue;
      }
    }
    // above/over/below/under/>/</at least/at most/faster than/slower than N [unit]
    const r = readThreshold(tokens, i);
    if (r && r.explicitOp) {
      const unit = r.unit ? UNIT_TO_FIELD[r.unit] : undefined;
      if (unit) {
        for (let k = i; k <= r.end; k++) tokens[k]!.used = true;
        addFilter(draft, unit.field, r.op, round(r.value * unit.factor), `${opWord(r.op)} ${r.value} ${unit.label}`);
      } else if (draft.types.includes(ObjectTypes.Earthquake)) {
        // Unitless threshold in an earthquake query is a magnitude.
        for (let k = i; k <= r.end; k++) tokens[k]!.used = true;
        addFilter(draft, 'properties.magnitude', r.op, r.value, `M${r.value}${r.op === 'gte' ? '+' : '-'}`);
      } else {
        for (let k = i; k <= r.end; k++) tokens[k]!.used = true;
        out.notes.push(`Threshold "${r.value}" ignored: no unit (use ft, m, kt, km/h).`);
      }
      i = r.end;
      continue;
    }
    // bare "5+" with earthquake context
    const plus = /^(\d+(?:\.\d+)?)\+$/.exec(t.lower);
    if (plus && draft.types.includes(ObjectTypes.Earthquake)) {
      t.used = true;
      addFilter(draft, 'properties.magnitude', 'gte', Number(plus[1]), `M${plus[1]}+`);
    }
  }
}

interface Threshold {
  op: 'gte' | 'lte' | 'gt' | 'lt';
  value: number;
  unit?: string;
  end: number;
  explicitOp: boolean;
}

function readThreshold(tokens: Token[], i: number): Threshold | undefined {
  const t = tokens[i];
  if (!t || t.used) return undefined;
  let op: Threshold['op'] | undefined;
  let j = i;
  let explicitOp = false;
  const two = `${t.lower} ${tokens[i + 1]?.lower ?? ''}`;
  if (
    two === 'at least' ||
    two === 'faster than' ||
    two === 'higher than' ||
    two === 'more than' ||
    two === 'greater than'
  ) {
    op = two === 'at least' ? 'gte' : 'gt';
    j = i + 2;
    explicitOp = true;
  } else if (two === 'at most' || two === 'slower than' || two === 'lower than' || two === 'less than') {
    op = two === 'at most' ? 'lte' : 'lt';
    j = i + 2;
    explicitOp = true;
  } else if (GTE_WORDS.has(t.lower)) {
    op = t.lower === '>' ? 'gt' : 'gte';
    j = i + 1;
    explicitOp = true;
  } else if (LTE_WORDS.has(t.lower)) {
    op = t.lower === '<' ? 'lt' : 'lte';
    j = i + 1;
    explicitOp = true;
  }
  // Single-token forms: ">10000ft", ">=5", "10000ft" (after magnitude/mag).
  const single = tokens[j];
  if (!single || single.used) return undefined;
  const m = /^([<>]=?|≥|≤)?(\d+(?:\.\d+)?)([a-z/]+)?$/i.exec(single.lower);
  if (!m) return undefined;
  if (m[1]) {
    op = m[1] === '>' ? 'gt' : m[1] === '<' ? 'lt' : m[1] === '<=' || m[1] === '≤' ? 'lte' : 'gte';
    explicitOp = true;
  }
  if (!op) op = 'gte';
  const value = Number(m[2]);
  if (!Number.isFinite(value)) return undefined;
  let unit = m[3]?.toLowerCase();
  let end = j;
  const after = tokens[j + 1];
  if (!unit && after && !after.used && UNIT_TO_FIELD[after.lower]) {
    unit = after.lower;
    end = j + 1;
  }
  if (unit && !UNIT_TO_FIELD[unit]) return undefined;
  return { op, value, end, explicitOp, ...(unit ? { unit } : {}) };
}

function addFilter(draft: Draft, field: string, op: WorldFilter['op'], value: number, label: string): void {
  draft.filters.push({ field, op, value });
  draft.filterText.push(label);
}
function opWord(op: Threshold['op']): string {
  return op === 'gte' ? 'at least' : op === 'gt' ? 'above' : op === 'lte' ? 'at most' : 'below';
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---- spatial ----------------------------------------------------------------

const NEAR_WORDS = new Set(['near', 'around', 'nearby', 'close']);
const OVER_WORDS = new Set(['over', 'above', 'across']);
const IN_WORDS = new Set(['in', 'at', 'inside', 'within']);

function extractSpatial(tokens: Token[], gazetteer: Gazetteer, draft: Draft, out: ParsedSearch): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.used) continue;
    let mode: 'near' | 'over' | 'in' | 'radius' | undefined;
    let radiusM: number | undefined;
    let j = i + 1;
    if (t.lower === 'within') {
      // within N km|mi|nm of X
      const n = tokens[i + 1],
        u = tokens[i + 2],
        of = tokens[i + 3];
      const nm = n && !n.used ? /^(\d+(?:\.\d+)?)(km|mi|nm|m)?$/.exec(n.lower) : null;
      if (nm) {
        const unitTok = nm[2] ?? (u && !u.used ? u.lower : undefined);
        const factor =
          unitTok === 'km'
            ? 1000
            : unitTok === 'mi' || unitTok === 'miles'
              ? 1609.344
              : unitTok === 'nm'
                ? 1852
                : unitTok === 'm'
                  ? 1
                  : undefined;
        if (factor !== undefined) {
          radiusM = Number(nm[1]) * factor;
          mode = 'radius';
          j = nm[2] ? i + 2 : i + 3;
          const ofTok = nm[2] ? u : of;
          if (ofTok && !ofTok.used && (ofTok.lower === 'of' || ofTok.lower === 'from')) j++;
        }
      }
      if (!mode) mode = 'in';
    } else if (t.lower === 'close' && tokens[i + 1]?.lower === 'to') {
      mode = 'near';
      j = i + 2;
    } else if (NEAR_WORDS.has(t.lower)) mode = 'near';
    else if (OVER_WORDS.has(t.lower)) mode = 'over';
    else if (IN_WORDS.has(t.lower)) mode = 'in';
    if (!mode) continue;
    if (tokens[j]?.lower === 'the' && !tokens[j]!.used) j++;
    // Place text = following unused, non-stop tokens up to the end (or the next used token).
    const span: number[] = [];
    for (let k = j; k < tokens.length; k++) {
      if (tokens[k]!.used) break;
      span.push(k);
    }
    if (span.length === 0) continue;
    const resolved = resolvePlaceSpan(tokens, span, gazetteer);
    if (!resolved) {
      draft.spatialUnresolved = span.map((k) => tokens[k]!.text).join(' ');
      out.notes.push(`Unknown place "${draft.spatialUnresolved}".`);
      t.used = true;
      for (const k of span) tokens[k]!.used = true;
      return;
    }
    t.used = true;
    for (let k = i + 1; k < j; k++) tokens[k]!.used = true;
    for (const k of resolved.consumed) tokens[k]!.used = true;
    const hit = resolved.hit;
    draft.region = regionFor(hit, mode, radiusM);
    draft.regionText = `${mode === 'radius' ? `within ${Math.round((radiusM ?? 0) / 1000)} km of` : mode} ${hit.name}`;
    return;
  }
}

function regionFor(hit: GazetteerHit, mode: 'near' | 'over' | 'in' | 'radius', radiusM: number | undefined): GeoRegion {
  if (mode === 'radius' && radiusM !== undefined) return { kind: 'circle', center: hit.position, radiusM };
  if (mode === 'near' && hit.kind !== 'country' && hit.kind !== 'region')
    return { kind: 'circle', center: hit.position, radiusM: NEAR_RADIUS_M[hit.kind] };
  if (hit.bounds) return { kind: 'bounds', bounds: hit.bounds };
  return { kind: 'circle', center: hit.position, radiusM: NEAR_RADIUS_M[hit.kind] };
}

/** Try the longest span first, then drop trailing words. Prefers exact matches; falls back to ≥0.7. */
function resolvePlaceSpan(
  tokens: Token[],
  span: number[],
  gazetteer: Gazetteer,
): { hit: GazetteerHit; consumed: number[] } | undefined {
  for (let len = span.length; len >= 1; len--) {
    const idx = span.slice(0, len);
    const words = idx.map((k) => tokens[k]!.text).filter((w) => !STOP_WORDS.has(w.toLowerCase()));
    if (words.length === 0) continue;
    const hits = gazetteer.lookup(words.join(' '), { limit: 5 });
    const best = hits[0];
    if (best && best.score >= 0.7) return { hit: best, consumed: idx };
  }
  return undefined;
}

// ---- leftover ----------------------------------------------------------------

function extractLeftover(tokens: Token[], gazetteer: Gazetteer, draft: Draft, out: ParsedSearch): void {
  const rest = tokens.filter((t) => !t.used && !STOP_WORDS.has(t.lower));
  for (const t of tokens) if (!t.used && STOP_WORDS.has(t.lower)) t.used = true;
  if (rest.length === 0) return;
  const text = rest.map((t) => t.text).join(' ');

  // Upper-case 3/4-letter codes are airport lookups first.
  if (rest.length === 1 && /^[A-Z]{3,4}$/.test(rest[0]!.text)) {
    const hits = gazetteer.lookup(rest[0]!.text, { kinds: ['airport'], limit: 3 });
    if (hits[0] && hits[0].score >= 1) {
      rest[0]!.used = true;
      for (const h of hits) if (h.score >= 1) out.intents.push(placeIntent(h));
      return;
    }
  }

  const hits = gazetteer.lookup(text, { limit: 5 });
  const best = hits[0];
  if (draft.types.length || draft.filters.length) {
    // "earthquakes Japan" → region (exact place name only); otherwise free text within the typed query.
    if (best && best.score >= 1 && !draft.region) {
      draft.region = regionFor(best, 'in', undefined);
      draft.regionText = `in ${best.name}`;
    } else {
      draft.freeText = text;
    }
    for (const t of rest) t.used = true;
    return;
  }
  // No structured intent: place hits plus a free-text query.
  for (const h of hits) out.intents.push(placeIntent(h));
  draft.freeText = text;
  for (const t of rest) t.used = true;
}

// ---- build --------------------------------------------------------------------

function buildQuery(draft: Draft): WorldQuery {
  const q: WorldQuery = {};
  if (draft.types.length) q.objectTypes = [...draft.types];
  if (draft.region) q.region = draft.region;
  if (draft.time) q.time = draft.time;
  if (draft.filters.length) q.filters = [...draft.filters];
  if (draft.freeText) q.text = draft.freeText;
  return q;
}

function buildTitle(draft: Draft): string {
  const parts: string[] = [];
  const label = draft.types.length ? draft.types.map(typeLabel).join(' & ') : 'Objects';
  // Magnitude reads naturally as a prefix ("M5+ earthquakes"); other thresholds as a suffix ("Aircraft above 30000 ft").
  const prefix = draft.filterText.filter((f) => f.startsWith('M'));
  const suffix = draft.filterText.filter((f) => !f.startsWith('M'));
  parts.push(prefix.length ? `${prefix.join(', ')} ${label.toLowerCase()}` : label);
  if (suffix.length) parts.push(suffix.join(', '));
  if (draft.freeText) parts.push(`"${draft.freeText}"`);
  if (draft.regionText) parts.push(draft.regionText);
  else if (draft.spatialUnresolved) parts.push(`near "${draft.spatialUnresolved}" (unknown place)`);
  if (draft.timeText) parts.push(`(${draft.timeText})`);
  return parts.join(' ');
}

// ---- commands ----------------------------------------------------------------

export interface CommandMatch {
  command: CommandDefinition;
  score: number;
}

/**
 * Fuzzy prefix matching: every query word must be a prefix of a title or keyword word.
 * Score = matched title words / title words (+0.1 when the whole query is a prefix of the title).
 * Two or more words that are each a whole title or keyword word, at least one of them the
 * title's, name the command outright ("fly to", "go to"): 0.9, so an object whose label
 * merely starts with one of the words ("FLYING LAPTOP") does not take Enter from it.
 */
export function matchCommands(text: string, commands: readonly CommandDefinition[]): CommandMatch[] {
  const q = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
  if (q.length < 2) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const out: CommandMatch[] = [];
  for (const c of commands) {
    const titleWords = c.title.toLowerCase().split(/\s+/);
    const kw = (c.keywords ?? []).map((k) => k.toLowerCase());
    const kwWords = kw.flatMap((k) => k.split(/\s+/));
    let titleHits = 0;
    let wholeTitle = 0;
    let whole = true;
    let ok = true;
    for (const w of words) {
      if (titleWords.some((tw) => tw.startsWith(w))) {
        titleHits++;
        if (titleWords.includes(w)) wholeTitle++;
        else if (!kwWords.includes(w)) whole = false;
      } else if (kw.some((k) => k.startsWith(w))) {
        if (!kwWords.includes(w)) whole = false;
      } else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let score = titleHits / titleWords.length;
    if (titleHits === 0) score = 0.4;
    if (c.title.toLowerCase().startsWith(q)) score = Math.min(1, score + 0.1);
    if (words.length >= 2 && whole && wholeTitle > 0) score = Math.max(score, 0.9);
    if (score > 0.3) out.push({ command: c, score: Math.round(score * 1000) / 1000 });
  }
  out.sort((a, b) => b.score - a.score || (a.command.title < b.command.title ? -1 : 1));
  return out;
}
