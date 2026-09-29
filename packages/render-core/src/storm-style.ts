import type { JsonValue } from '@worldview/world-model';

/**
 * How a storm reads on the map: tropical cyclones drawn with the cyclone glyph in their
 * Saffir–Simpson colour and a "Name · Cat 3 · 115 kt" label, their forecast positions labelled
 * with the time and intensity NHC gives for them, their past track coloured by the strength it
 * was drawn at, their wind field in three rings, and tornadoes — a warning or a report — with
 * the tornado glyph. Pure functions of an object's type and properties, for presentation.ts,
 * the legend and the Storms quick view, and tests.
 *
 * Inputs, all written by sources already on the branch or added with this file:
 *
 *   storm           providers/nhc CurrentStorms: `intensityKt`, `classification` (TD, TS, HU,
 *                   STD, STS, PTC, PC), `name`
 *   weather-alert   GDACS tropical cyclone alerts: `gdacsEventType: "TC"`, `maxWindKmh` (the
 *                   warning centre's wind, so the category is an *equivalent*)
 *                   NHC MapServer layers, told apart by the literal `cycloneLayer` each
 *                   definition writes: `forecast-point` (layer 5: `intensityKt`, `forecastTime`
 *                   such as "8:00 AM Tue", `timeZone`, `stormType`), `past-track` (layer 11: `trackCategory`,
 *                   the segment's Saffir–Simpson number as text, and `stormType`), `wind-field`
 *                   (layer 16: `windRadiiKt` 34, 50 or 64)
 *                   NWS warnings: `alertKind` tornado-warning, -pds, -emergency (providers/weather)
 *                   NWS storm reports: `reportType` Tornado, Funnel Cloud, Waterspout, Landspout
 */

/** Tropical depression, tropical storm, and hurricane categories 1–5 (Saffir–Simpson). */
export const CYCLONE_CATEGORIES = ['td', 'ts', 'cat1', 'cat2', 'cat3', 'cat4', 'cat5'] as const;
export type CycloneCategory = (typeof CYCLONE_CATEGORIES)[number];

/** Short names, as the label writes them. */
export const CYCLONE_CATEGORY_SHORT: Readonly<Record<CycloneCategory, string>> = Object.freeze({
  td: 'TD',
  ts: 'TS',
  cat1: 'Cat 1',
  cat2: 'Cat 2',
  cat3: 'Cat 3',
  cat4: 'Cat 4',
  cat5: 'Cat 5',
});

/** Full names, for the legend and the context panel. */
export const CYCLONE_CATEGORY_NAMES: Readonly<Record<CycloneCategory, string>> = Object.freeze({
  td: 'Tropical depression',
  ts: 'Tropical storm',
  cat1: 'Category 1',
  cat2: 'Category 2',
  cat3: 'Category 3 (major)',
  cat4: 'Category 4 (major)',
  cat5: 'Category 5 (major)',
});

/**
 * Saffir–Simpson hurricane wind scale from 1-minute sustained wind in knots — NHC's
 * thresholds: Category 1 64–82 kt, 2 83–95, 3 96–112, 4 113–136, 5 137 and up. Below 64 kt,
 * undefined: not a hurricane.
 */
export function saffirSimpsonCategory(kt: number): 1 | 2 | 3 | 4 | 5 | undefined {
  if (!Number.isFinite(kt) || kt < 64) return undefined;
  if (kt >= 137) return 5;
  if (kt >= 113) return 4;
  if (kt >= 96) return 3;
  if (kt >= 83) return 2;
  return 1;
}

/**
 * The category of a cyclone with `kt` of sustained wind: a depression below 34 kt, a
 * tropical storm to 63 kt, then the hurricane category. A typhoon or a severe cyclone of the
 * same wind gets the same one — the scale is the common yardstick the map colours by, and the
 * label says "eq." where the wind is not NHC's own (see `cycloneOf`).
 */
export function cycloneCategory(kt: number): CycloneCategory {
  const cat = saffirSimpsonCategory(kt);
  if (cat) return `cat${cat}`;
  return kt >= 34 ? 'ts' : 'td';
}

/** The category's rank, 0 (depression) to 6 (Category 5), for sorting and sizing. */
export function cycloneRank(category: CycloneCategory): number {
  return CYCLONE_CATEGORIES.indexOf(category);
}

export interface CycloneInfo {
  /** A storm now (NHC, GDACS), a forecast position, or a piece of the path it has taken. */
  role: 'current' | 'forecast' | 'past-track';
  name?: string;
  /** Sustained wind in knots, when the source gives it. */
  kt?: number;
  /** Undefined only for a piece of past track while it was not yet a cyclone (a low, a disturbance). */
  category?: CycloneCategory;
  /** The category is an equivalent: the wind is not NHC's 1-minute average (GDACS). */
  equivalent: boolean;
  /** Post-tropical or potential tropical cyclone: drawn grey, whatever its wind. */
  post: boolean;
  /** A forecast position's time as NHC labels it, compacted: "Tue 8 AM HST". */
  when?: string;
}

type Props = Readonly<Record<string, JsonValue | undefined>>;
export interface StormLike {
  type: string;
  properties: Props;
  labels?: Readonly<Record<string, string | undefined>>;
}

const str = (p: Props, k: string): string | undefined => {
  const v = p[k];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};
const num = (p: Props, k: string): number | undefined => {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

/** NHC storm type codes of a system that is no longer (or not yet) a tropical cyclone. */
const POST_TROPICAL_TYPES: ReadonlySet<string> = new Set(['PTC', 'PC', 'EX', 'LO', 'RL', 'PT']);

/** CurrentStorms / MapServer storm type codes → a category when the wind is not given. */
function categoryFromType(type: string | undefined): CycloneCategory | undefined {
  switch (type?.toUpperCase()) {
    case 'TD':
    case 'STD':
      return 'td';
    case 'TS':
    case 'STS':
      return 'ts';
    case 'HU':
    case 'TY':
    case 'MH':
      return 'cat1';
    default:
      return undefined;
  }
}

/**
 * "8:00 AM Tue" (NHC's `datelbl`, the storm's local time) and its zone → "Tue 8 AM HST". Any
 * other shape is kept as it came.
 */
export function compactForecastTime(label: string, zone?: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)\s+([A-Za-z]{3})$/i.exec(label.trim());
  const z = zone && /^[A-Z]{2,5}$/.test(zone) ? ` ${zone}` : '';
  if (!m) return `${label.trim()}${z}`;
  const minutes = m[2] === '00' ? '' : `:${m[2]}`;
  return `${m[4]} ${Number(m[1])}${minutes} ${m[3]!.toUpperCase()}${z}`;
}

/** What `obj` is as a tropical cyclone, or undefined when it is not one. */
export function cycloneOf(obj: StormLike): CycloneInfo | undefined {
  const p = obj.properties;
  if (obj.type === 'storm') {
    const kt = num(p, 'intensityKt');
    const classification = str(p, 'classification')?.toUpperCase();
    const category = kt !== undefined ? cycloneCategory(kt) : categoryFromType(classification);
    const info: CycloneInfo = {
      role: 'current',
      equivalent: false,
      post: classification === 'PTC' || classification === 'PC',
    };
    const name = str(p, 'name') ?? obj.labels?.['name'];
    if (name) info.name = name;
    if (kt !== undefined) info.kt = kt;
    if (category) info.category = category;
    return info;
  }
  if (obj.type !== 'weather-alert') return undefined;
  if (str(p, 'gdacsEventType') === 'TC') {
    const kmh = num(p, 'maxWindKmh');
    const info: CycloneInfo = { role: 'current', equivalent: true, post: false };
    const name = obj.labels?.['name'] ?? str(p, 'title');
    if (name) info.name = name;
    if (kmh !== undefined && kmh > 0) {
      info.kt = Math.round(kmh / 1.852);
      info.category = cycloneCategory(info.kt);
    }
    return info;
  }
  const layer = str(p, 'cycloneLayer');
  if (layer === 'forecast-point') {
    const kt = num(p, 'intensityKt');
    const type = str(p, 'stormType')?.toUpperCase();
    const category = kt !== undefined ? cycloneCategory(kt) : categoryFromType(type);
    // A forecast position as a post-tropical or remnant low still has its wind, but no longer
    // the structure the category describes.
    const info: CycloneInfo = { role: 'forecast', equivalent: false, post: POST_TROPICAL_TYPES.has(type ?? '') };
    const name = str(p, 'stormName') ?? obj.labels?.['name'];
    if (name) info.name = name;
    if (kt !== undefined) info.kt = kt;
    if (category) info.category = category;
    const time = str(p, 'forecastTime');
    if (time) info.when = compactForecastTime(time, str(p, 'timeZone'));
    return info;
  }
  if (layer === 'past-track') {
    const ss = Number(str(p, 'trackCategory') ?? num(p, 'trackCategory'));
    const info: CycloneInfo = { role: 'past-track', equivalent: false, post: false };
    const category =
      Number.isInteger(ss) && ss >= 1 && ss <= 5
        ? (`cat${ss}` as CycloneCategory)
        : categoryFromType(str(p, 'stormType'));
    if (category) info.category = category;
    const name = str(p, 'stormName') ?? obj.labels?.['name'];
    if (name) info.name = name;
    return info;
  }
  return undefined;
}

/**
 * The map label: "Nolo · Cat 4 · 125 kt"; a GDACS storm "Sample · Cat 4 eq. · 125 kt"; a
 * forecast position "Tue 8 AM HST · Cat 3 · 110 kt". Parts the source does not give are left
 * out; a piece of past track has no label.
 */
export function cycloneLabel(c: CycloneInfo): string | undefined {
  if (c.role === 'past-track') return undefined;
  const parts: string[] = [];
  if (c.role === 'forecast') {
    if (c.when) parts.push(c.when);
  } else if (c.name) parts.push(c.name);
  if (c.post) parts.push('Post-tropical');
  else if (c.category) parts.push(`${CYCLONE_CATEGORY_SHORT[c.category]}${c.equivalent ? ' eq.' : ''}`);
  if (c.kt !== undefined) parts.push(`${Math.round(c.kt)} kt`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** NWS warning kinds that mean a tornado now (providers/weather `alertKind`), most urgent first. */
export const TORNADO_WARNING_KINDS: readonly string[] = Object.freeze([
  'tornado-emergency',
  'tornado-pds',
  'tornado-warning',
]);

/** NWS storm report types that are a tornado or its kin (the service's own names). */
export const TORNADO_REPORT_TYPES: readonly string[] = Object.freeze([
  'Tornado',
  'Funnel Cloud',
  'Waterspout',
  'Landspout',
]);

/** 0 for no tornado warning, else 3 (emergency), 2 (PDS), 1 (warning): the urgency among tornado warnings. */
export function tornadoWarningRank(obj: StormLike): number {
  if (obj.type !== 'weather-alert') return 0;
  const kind = str(obj.properties, 'alertKind');
  const i = kind ? TORNADO_WARNING_KINDS.indexOf(kind) : -1;
  return i < 0 ? 0 : TORNADO_WARNING_KINDS.length - i;
}

export function isTornadoReport(obj: StormLike): boolean {
  if (obj.type !== 'weather-alert') return false;
  const t = str(obj.properties, 'reportType');
  return t !== undefined && TORNADO_REPORT_TYPES.includes(t);
}

export interface HazardStyle {
  /** The whole style class, replacing the rule's: `storm.cat3`, `storm.wind-64`. */
  styleClass?: string;
  /** Drawn in 'markers' mode as well as 'icons', so the glyph reads at global zoom. */
  icon?: 'cyclone' | 'tornado';
  /** Written in 'markers' mode as well as 'icons'. */
  label?: string;
  /** Marker or glyph diameter in px before selection emphasis. */
  sizePx?: number;
  /** Added to the rule's base priority (drawing order, label placement, the feature cap). */
  priorityBoost?: number;
}

/** Glyph size of a current cyclone by category: a depression 16 px, a Category 5 28 px. */
const CURRENT_SIZE_PX = [16, 18, 20, 22, 24, 26, 28];

/**
 * The storm treatment for `obj`, or undefined to leave it to its rule. Priorities: a tornado
 * warning is above everything else on the map (+40 on the weather-alert rule's 65, over a
 * cyclone's 90), its emergency and PDS tiers higher still; a current cyclone rises with its
 * category.
 */
export function hazardStyle(obj: StormLike): HazardStyle | undefined {
  const tornado = tornadoWarningRank(obj);
  if (tornado) return { icon: 'tornado', priorityBoost: 38 + tornado };
  if (isTornadoReport(obj)) return { icon: 'tornado', priorityBoost: 5 };
  if (obj.type === 'weather-alert' && str(obj.properties, 'cycloneLayer') === 'wind-field') {
    const kt = num(obj.properties, 'windRadiiKt');
    const ring = kt === 64 ? 'wind-64' : kt === 50 ? 'wind-50' : 'wind-34';
    return { styleClass: `storm.${ring}`, sizePx: 3, priorityBoost: -10 };
  }
  const c = cycloneOf(obj);
  if (!c) return undefined;
  const tone = c.post ? 'post' : (c.category ?? 'weak');
  const out: HazardStyle = { styleClass: `storm.${tone}` };
  const label = cycloneLabel(c);
  if (label) out.label = label;
  if (c.role === 'current') {
    out.icon = 'cyclone';
    out.sizePx = CURRENT_SIZE_PX[c.category ? cycloneRank(c.category) : 0]!;
    out.priorityBoost = (obj.type === 'storm' ? 0 : 25) + (c.category ? cycloneRank(c.category) : 0);
  } else if (c.role === 'forecast') {
    out.icon = 'cyclone';
    out.sizePx = 11;
    out.priorityBoost = 5;
  } else {
    out.sizePx = 4;
    out.priorityBoost = -5;
  }
  return out;
}
