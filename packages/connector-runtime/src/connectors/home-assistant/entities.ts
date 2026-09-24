import type { JsonValue } from '@worldview/world-model';
import { resolveTransform } from '@worldview/connector-sdk';

/**
 * Home Assistant entities as records a definition's mapping can read (phase
 * `home-assistant`). A state object from `/api/states` or a `state_changed` event's
 * `new_state` is checked, the entity selection applied, and derived fields added under `_`
 * names (so they can never clash with Home Assistant's own keys):
 *
 *   `_domain`, `_objectId`  the two halves of `entity_id`
 *   `_position`             `[lat, lon]` from the entity's `latitude`/`longitude` attributes,
 *                           or from the operator's positions table; absent otherwise
 *   `_positionSource`       `attributes`, `table` or `zone`
 *   `_home`                 `[lat, lon]` of `zone.home` — where Home Assistant says home is
 *   `_numeric`              the state as a number, when it is one
 *   `_available`            false when the state is `unavailable` or `unknown`
 *   `_si`                   readings converted to SI units by the transform registry
 *                           (`value`/`unit` for a sensor; temperatures, pressure, wind speed,
 *                           visibility for a weather entity), only when the unit is stated
 *
 * Nothing here guesses: a unit Home Assistant does not state is not converted, and an
 * entity with no coordinates and no table entry has no `_position`.
 */

/** `domain.object_id`, as Home Assistant spells entity ids. */
export const ENTITY_ID = /^[a-z0-9_]{1,64}\.[a-z0-9_]{1,192}$/;

/**
 * Domains never read, whatever a definition or a setting selects: they are phones, personal
 * trackers and named people (docs/PRODUCT-BOUNDARIES.md — no private-device tracking, no
 * following a named person). Their states are dropped as they arrive: never kept, mapped or
 * emitted.
 */
export const REFUSED_DOMAINS: ReadonlySet<string> = new Set(['person', 'device_tracker']);

export const MAX_SELECTORS = 64;
export const MAX_POSITIONS = 64;
/** A setting longer than this is not parsed at all. */
export const MAX_SETTING_CHARS = 16 * 1024;

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, JsonValue>;
  last_changed?: string;
  last_updated?: string;
}

export function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf('.'));
}

export function isRefused(entityId: string): boolean {
  return REFUSED_DOMAINS.has(domainOf(entityId));
}

/**
 * A state object as Home Assistant sends it, or why it is not one. A zone's state is how
 * many people are in it and its `persons` attribute who they are, and its update times move
 * when someone arrives or leaves: all three are dropped here, where every state enters, so
 * a zone says where it is and nothing about who is there (PRODUCT-BOUNDARIES).
 */
export function readState(raw: unknown): HaState | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
  const r = raw as Record<string, unknown>;
  const id = r['entity_id'];
  if (typeof id !== 'string' || !ENTITY_ID.test(id)) return 'entity_id missing or not an entity id';
  // A refused entity's id is not repeated in a message that may reach Source Health.
  const named = isRefused(id) ? 'a refused entity' : id;
  const state = r['state'];
  if (typeof state !== 'string') return `${named}: state is not a string`;
  const attributes = r['attributes'];
  if (attributes !== undefined && (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)))
    return `${named}: attributes is not an object`;
  if (domainOf(id) === 'zone') {
    const { persons: _persons, ...rest } = (attributes ?? {}) as Record<string, JsonValue>;
    return { entity_id: id, state: '', attributes: rest };
  }
  const out: HaState = {
    entity_id: id,
    state,
    attributes: (attributes ?? {}) as Record<string, JsonValue>,
  };
  if (typeof r['last_changed'] === 'string') out.last_changed = r['last_changed'];
  if (typeof r['last_updated'] === 'string') out.last_updated = r['last_updated'];
  return out;
}

/** Whether two states say the same thing (update times aside). */
export function sameState(a: HaState, b: HaState): boolean {
  return a.state === b.state && JSON.stringify(a.attributes) === JSON.stringify(b.attributes);
}

// ---------------------------------------------------------------------------------------
// Entity selection: globs over entity ids (`sensor.outdoor_*`, `weather.*`, `zone.home`).

export interface EntitySelector {
  /** The pattern as written, lower-cased, runs of `*` collapsed to one. */
  source: string;
}

export interface ParsedList<T> {
  items: T[];
  /** Entries that were ignored, with why (shown in Source Health). */
  problems: string[];
}

const GLOB = /^[a-z0-9_*]{1,64}\.[a-z0-9_*]{1,192}$/;

/**
 * `*` matching any run of `[a-z0-9_]` in `text` (neither may contain a dot). A two-pointer
 * scan that remembers only the last star: at most |pattern| × |text| steps, however many
 * stars there are — no regular expression, so no backtracking blow-up.
 */
function wildcard(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      resume = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Whether an entity id matches a selector: each half of the id against the same half of the pattern. */
export function matches(selector: EntitySelector, entityId: string): boolean {
  const dot = selector.source.indexOf('.');
  const at = entityId.indexOf('.');
  if (dot < 0 || at < 0 || entityId.includes('.', at + 1)) return false;
  return (
    wildcard(selector.source.slice(0, dot), entityId.slice(0, at)) &&
    wildcard(selector.source.slice(dot + 1), entityId.slice(at + 1))
  );
}

function selectorOf(glob: string): EntitySelector {
  return { source: glob.replace(/\*+/g, '*') };
}

/** Split a setting into entries on commas, semicolons and line breaks. */
function entries(raw: string): string[] {
  return raw
    .split(/[,;\r\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The `entities` setting: entity-id globs separated by commas, semicolons or new lines, `*`
 * the only wildcard (within one half of the id when the dot is given). Empty → no selection
 * beyond the definition's own filter. At most `MAX_SELECTORS`.
 */
export function parseSelectors(raw: string | undefined): ParsedList<EntitySelector> {
  const out: ParsedList<EntitySelector> = { items: [], problems: [] };
  if (!raw) return out;
  if (raw.length > MAX_SETTING_CHARS) {
    out.problems.push(`entities is longer than ${MAX_SETTING_CHARS} characters; ignored`);
    return out;
  }
  for (const e of entries(raw.toLowerCase().replace(/\s+/g, ','))) {
    if (out.items.length >= MAX_SELECTORS) {
      out.problems.push(`more than ${MAX_SELECTORS} entity patterns; the rest are ignored`);
      break;
    }
    if (!GLOB.test(e)) {
      out.problems.push(`"${e.slice(0, 40)}" is not an entity id or pattern (domain.object_id, * as wildcard)`);
      continue;
    }
    out.items.push(selectorOf(e));
  }
  return out;
}

export function matchesAny(entityId: string, selectors: readonly EntitySelector[]): boolean {
  return selectors.some((s) => matches(s, entityId));
}

// ---------------------------------------------------------------------------------------
// Positions table: where an entity without coordinates stands.

export type PositionTarget = { kind: 'fixed'; lat: number; lon: number } | { kind: 'zone'; zone: string };

export interface PositionEntry {
  selector: EntitySelector;
  target: PositionTarget;
}

/**
 * The `positions` setting: entries `<entity pattern> = <lat>,<lon>` or
 * `<entity pattern> = zone.<name>`, separated by semicolons or new lines (a comma belongs
 * to the coordinates). The first entry whose pattern matches wins. At most `MAX_POSITIONS`.
 */
export function parsePositions(raw: string | undefined): ParsedList<PositionEntry> {
  const out: ParsedList<PositionEntry> = { items: [], problems: [] };
  if (!raw) return out;
  if (raw.length > MAX_SETTING_CHARS) {
    out.problems.push(`positions is longer than ${MAX_SETTING_CHARS} characters; ignored`);
    return out;
  }
  const lines = raw
    .split(/[;\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (out.items.length >= MAX_POSITIONS) {
      out.problems.push(`more than ${MAX_POSITIONS} positions; the rest are ignored`);
      break;
    }
    const eq = line.indexOf('=');
    const shown = `"${line.slice(0, 40)}"`;
    if (eq < 0) {
      out.problems.push(`${shown} has no "="`);
      continue;
    }
    const pattern = line.slice(0, eq).trim().toLowerCase();
    const value = line
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    if (!GLOB.test(pattern)) {
      out.problems.push(`${shown}: "${pattern.slice(0, 40)}" is not an entity id or pattern`);
      continue;
    }
    const selector = selectorOf(pattern);
    const zone = /^zone\.[a-z0-9_]{1,192}$/.exec(value);
    if (zone) {
      out.items.push({ selector, target: { kind: 'zone', zone: value } });
      continue;
    }
    const coords = /^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(value);
    const lat = coords ? Number(coords[1]) : NaN;
    const lon = coords ? Number(coords[2]) : NaN;
    if (!coords || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) {
      out.problems.push(`${shown}: expected "<lat>,<lon>" in degrees or "zone.<name>"`);
      continue;
    }
    out.items.push({ selector, target: { kind: 'fixed', lat, lon } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Enrichment.

function coordinate(v: JsonValue | undefined, limit: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit ? v : undefined;
}

/** `[lat, lon]` from a state's `latitude`/`longitude` attributes (numbers, in range, not both 0). */
export function attributePosition(s: HaState | undefined): [number, number] | undefined {
  if (!s) return undefined;
  const lat = coordinate(s.attributes['latitude'], 90);
  const lon = coordinate(s.attributes['longitude'], 180);
  if (lat === undefined || lon === undefined || (lat === 0 && lon === 0)) return undefined;
  return [lat, lon];
}

function numeric(v: JsonValue | undefined): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

type Converter = { to: string; transform?: string };

/** Home Assistant's unit spellings → the SI (or display-SI) unit and the registry transform that gets there. */
const UNITS: Readonly<Record<string, Converter>> = Object.freeze({
  '°C': { to: '°C' },
  '°F': { to: '°C', transform: 'fahrenheitToCelsius' },
  K: { to: '°C', transform: 'kelvinToCelsius' },
  'm/s': { to: 'm/s' },
  'km/h': { to: 'm/s', transform: 'kmhToMps' },
  mph: { to: 'm/s', transform: 'mphToMps' },
  kn: { to: 'm/s', transform: 'knotsToMps' },
  'ft/s': { to: 'm/s', transform: 'scale:0.3048' },
  hPa: { to: 'hPa' },
  mbar: { to: 'hPa' },
  Pa: { to: 'hPa', transform: 'paToHpa' },
  kPa: { to: 'hPa', transform: 'scale:10' },
  inHg: { to: 'hPa', transform: 'inchesHgToHpa' },
  mmHg: { to: 'hPa', transform: 'scale:1.333224' },
  psi: { to: 'hPa', transform: 'scale:68.94757' },
  mm: { to: 'mm' },
  in: { to: 'mm', transform: 'inchesToMm' },
  m: { to: 'm' },
  km: { to: 'm', transform: 'kilometersToMeters' },
  mi: { to: 'm', transform: 'milesToMeters' },
  ft: { to: 'm', transform: 'feetToMeters' },
});

/**
 * A value in `unit` converted to SI through the transform registry (to three decimals);
 * undefined when the unit is not one it knows. `K` is a temperature only when the caller
 * says the reading is one (`temperature`): a colour temperature in kelvin stays in kelvin.
 */
export function toSi(
  value: number,
  unit: string,
  opts: { temperature?: boolean } = {},
): { value: number; unit: string } | undefined {
  if (unit === 'K' && !opts.temperature) return undefined;
  const c = UNITS[unit];
  if (!c) return undefined;
  if (!c.transform) return { value, unit: c.to };
  const out = resolveTransform(c.transform)!(value);
  return typeof out === 'number' && Number.isFinite(out)
    ? { value: Math.round(out * 1000) / 1000, unit: c.to }
    : undefined;
}

/** Weather attributes and the attribute that states each one's unit. */
const WEATHER_READINGS: ReadonlyArray<[string, string, string]> = [
  ['temperature', 'temperature_unit', 'temperatureC'],
  ['apparent_temperature', 'temperature_unit', 'apparentTemperatureC'],
  ['dew_point', 'temperature_unit', 'dewPointC'],
  ['pressure', 'pressure_unit', 'pressureHpa'],
  ['wind_speed', 'wind_speed_unit', 'windSpeedMps'],
  ['wind_gust_speed', 'wind_speed_unit', 'windGustMps'],
  ['visibility', 'visibility_unit', 'visibilityM'],
];

function siReadings(s: HaState, domain: string): Record<string, JsonValue> | undefined {
  const si: Record<string, JsonValue> = {};
  if (domain === 'weather') {
    for (const [key, unitKey, name] of WEATHER_READINGS) {
      const v = numeric(s.attributes[key]);
      const unit = s.attributes[unitKey];
      if (v === undefined || typeof unit !== 'string') continue;
      const c = toSi(v, unit, { temperature: unitKey === 'temperature_unit' });
      if (c) si[name] = c.value;
    }
    const humidity = numeric(s.attributes['humidity']);
    if (humidity !== undefined && humidity >= 0 && humidity <= 100) si['humidityPct'] = humidity;
    const bearing = numeric(s.attributes['wind_bearing']);
    if (bearing !== undefined) si['windDirDeg'] = ((bearing % 360) + 360) % 360;
  } else {
    const v = numeric(s.state);
    const unit = s.attributes['unit_of_measurement'];
    if (v !== undefined) {
      const temperature = s.attributes['device_class'] === 'temperature';
      const c = typeof unit === 'string' ? toSi(v, unit, { temperature }) : undefined;
      if (c) {
        si['value'] = c.value;
        si['unit'] = c.unit;
      } else {
        // A unit with no SI counterpart (%, W, kWh, µg/m³, ppm) is kept as Home Assistant states it.
        si['value'] = v;
        if (typeof unit === 'string' && unit.length <= 16) si['unit'] = unit;
      }
    }
  }
  return Object.keys(si).length ? si : undefined;
}

export interface EnrichOptions {
  positions: readonly PositionEntry[];
  /** Look up another entity's state (for `zone.home` and `zone.<name>` table targets). */
  stateOf: (entityId: string) => HaState | undefined;
}

/** The record the mapping reads: the state object as Home Assistant sent it, plus the derived `_` fields. */
export function enrich(s: HaState, opts: EnrichOptions): Record<string, JsonValue> {
  const domain = domainOf(s.entity_id);
  const record: Record<string, JsonValue> = {
    entity_id: s.entity_id,
    state: s.state,
    attributes: s.attributes,
    _domain: domain,
    _objectId: s.entity_id.slice(domain.length + 1),
    _available: s.state !== 'unavailable' && s.state !== 'unknown',
  };
  if (s.last_changed) record['last_changed'] = s.last_changed;
  if (s.last_updated) record['last_updated'] = s.last_updated;
  const own = attributePosition(s);
  if (own) {
    record['_position'] = own;
    record['_positionSource'] = 'attributes';
  } else {
    const entry = opts.positions.find((p) => matches(p.selector, s.entity_id));
    if (entry?.target.kind === 'fixed') {
      record['_position'] = [entry.target.lat, entry.target.lon];
      record['_positionSource'] = 'table';
    } else if (entry?.target.kind === 'zone') {
      const at = attributePosition(opts.stateOf(entry.target.zone));
      if (at) {
        record['_position'] = at;
        record['_positionSource'] = 'zone';
      }
    }
  }
  const home = attributePosition(opts.stateOf('zone.home'));
  if (home) record['_home'] = home;
  const n = numeric(s.state);
  if (n !== undefined) record['_numeric'] = n;
  const si = siReadings(s, domain);
  if (si) record['_si'] = si;
  return record;
}
