import type { JsonValue } from '@worldview/world-model';

/**
 * What kind of aircraft an object is, for its silhouette on the map and a line in the
 * context panel. Two inputs, both in the payload every ADS-B provider already carries:
 *
 *   `typeCode`  — the ICAO type designator from the aggregator's database (A320, B77W, H60,
 *                 C172). The more specific of the two, so it is read first, against short
 *                 tables of the common designators of each class.
 *   `category`  — the ADS-B emitter category the transponder broadcasts (DO-260B §2.2.3.2.5):
 *                 A1 light, A2 small, A3 large, A4 high-vortex large (B757), A5 heavy,
 *                 A6 high performance, A7 rotorcraft, B1 glider, B2 lighter-than-air,
 *                 B3 parachutist, B4 ultralight, B6 unmanned, B7 space vehicle, C* surface.
 *                 Coarse, but present for aircraft no database knows.
 *
 * Neither → `unknown`, drawn with the generic jet as before. The tables follow the
 * approach of GEV's aircraftClass.js (MIT): a designator's family decides its shape, and
 * the lists name families rather than every variant.
 *
 * Ten classes and ten sprites: each class is one atlas entry however many aircraft
 * share it (render-cesium sprites.ts, render-maplibre images.ts). Business jets became a
 * class of their own with the 3D models (render-cesium layers/models.ts): a Citation drawn
 * as an airliner four times its length read wrong close in, and the designators are few and
 * well known. The list is GEV's BIZJET set (aircraftClass.js, MIT) as a pattern.
 */
export const AIRCRAFT_CLASSES = [
  'jet',
  'business',
  'heavy',
  'turboprop',
  'light',
  'helicopter',
  'fast-jet',
  'glider',
  'balloon',
  'uav',
  'unknown',
] as const;
export type AircraftClass = (typeof AIRCRAFT_CLASSES)[number];

/** Icon id (icons.ts) per class. */
export const AIRCRAFT_CLASS_ICON: Readonly<Record<AircraftClass, string>> = {
  jet: 'aircraft',
  business: 'aircraft-business',
  heavy: 'aircraft-heavy',
  turboprop: 'aircraft-turboprop',
  light: 'aircraft-light',
  helicopter: 'helicopter',
  'fast-jet': 'aircraft-fastjet',
  glider: 'aircraft-glider',
  balloon: 'balloon',
  uav: 'uav',
  unknown: 'aircraft',
};

export const AIRCRAFT_CLASS_LABELS: Readonly<Record<AircraftClass, string>> = {
  jet: 'Jet airliner',
  business: 'Business jet',
  heavy: 'Wide-body / heavy',
  turboprop: 'Turboprop / regional',
  light: 'Light aircraft',
  helicopter: 'Helicopter',
  'fast-jet': 'Fast jet',
  glider: 'Glider',
  balloon: 'Balloon / airship',
  uav: 'Unmanned (UAV)',
  unknown: 'Unknown',
};

const BY_TYPE: ReadonlyArray<[AircraftClass, RegExp]> = [
  [
    'helicopter',
    /^(H\d{2}|H47|H53|H60|H64|EC\d{2}|AS3[23B]|AS5[05]|AS65|A109|A119|A139|A149|A169|A189|AW\d{3}|B06T?|B105|B212|B222|B230|B407|B412|B427|B429|B430|B505|B525|BK17|R22|R44|R66|S61|S64|S76|S92|MI\d{1,2}|KA\d{2}|CH47|UH1|NH90|EH10|LYNX|PUMA|ALO\d|GAZL|V22)$/,
  ],
  [
    'fast-jet',
    /^(F1[4-8][A-Z]?|F22|F35|FA18|F4|F5|EUFI|RFAL|JAS39|GRIF|TOR|MIR2|M2KC?|SU2[57]|SU3[0-5]|MG2[39]|MG3[15]|J10|J11|J15|J16|J20|JF17|T38|T7|HAWK|A10|AV8B|HAR|L39|L159|M346|T50|KFIR|TEJS)$/,
  ],
  [
    'heavy',
    /^(A30[06B]|A310|A33\d|A34\d|A35\d|A35K|A38\d|A3ST|B74\w|B76\w|B77\w|B78\w|MD11|DC10|L101|IL62|IL76|IL86|IL96|C17|C5M?|A400|A124|A225|K35[RE]|C135|E3[TC]F|E6|KC10|B703|KC46)$/,
  ],
  [
    'business',
    /^(C50[01]|C510|C525|C25[ABCM]|C55[01]|C56X|C560|C650|C68[0A]|C700|C750|CL3[05]|CL60|GLF[2-6]|GA[56]C|G150|G280|GL[57]T|GLEX|LJ(2[345]|3[15]|4[05]|55|60|7[05])|FA(10|20|50|7X|8X)|F900|F2TH|H25[ABC]|HDJT|E50P|E55P|E545|E550|PC24|PRM1|BE40|ASTR|WW24|SF50)$/,
  ],
  [
    'turboprop',
    /^(AT[4-7]\d|ATP|DH8\w|DHC[2-7]|SF34|SB20|E110|E120|D228|D328|JS3\d|JS41|F27|F50|AN2[46]|AN12|AN32|C130|C30J|L100|P3|C295|CN35|BE9\w|BE20|BE30|B350|B190|PC12|PC6T|C208|L410|SW[34]|TBM\d|P180|Y12|MA60|C27J|E2|DHC8|AN22|PC21|PC7|PC9|T6|TEX2)$/,
  ],
  [
    'light',
    /^(C1[5-9]\d|C20[5-7]|C210|P28\w|PA\d{2}|P32\w|P46T?|SR2\w|DA[24]\d|DA62|BE3[3-6]|BE5[58]|BE76|M20\w|AA5|RV\d{1,2}|C42|CH7A|J3|DR40|TB\d{1,2}|TOBA|P2002|SF25|ULAC|G115|EV97)$/,
  ],
  ['glider', /^(GLID|ASK\d{2}|DG\d{1,3}|LS\d|DUOD|DISC|NIMB|VENT|JANU|ARCP|SZD\w|G103)$/],
  ['balloon', /^(BALL|SHIP|ZEPP)$/],
  ['uav', /^(Q1|Q4|Q9|UAV|DRON|HRON|GLHK|MQ\d{1,2}|RQ\d{1,2}|TB2)$/],
];

const BY_CATEGORY: Readonly<Record<string, AircraftClass>> = {
  A1: 'light',
  A2: 'jet',
  A3: 'jet',
  A4: 'jet',
  A5: 'heavy',
  A6: 'fast-jet',
  A7: 'helicopter',
  B1: 'glider',
  B2: 'balloon',
  B4: 'light',
  B6: 'uav',
};

/** The class from a type designator alone, or undefined when the tables do not know it. */
export function classFromType(typeCode: string): AircraftClass | undefined {
  const t = typeCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,5}$/.test(t)) return undefined;
  for (const [cls, re] of BY_TYPE) if (re.test(t)) return cls;
  return undefined;
}

/**
 * The class for an aircraft's properties. A designator the tables know decides; otherwise
 * the emitter category does; a designator neither knows is drawn as the generic jet (the
 * commonest thing a database-registered type is), and nothing at all as `unknown`.
 */
export function aircraftClass(properties: Readonly<Record<string, JsonValue>>): AircraftClass {
  const type = str(properties['typeCode']) ?? str(properties['aircraftType']);
  const category = str(properties['category'])?.toUpperCase();
  const key = `${type ?? ''}|${category ?? ''}`;
  const hit = MEMO.get(key);
  if (hit) return hit;
  const byType = type ? classFromType(type) : undefined;
  const byCategory = category ? BY_CATEGORY[category] : undefined;
  let out: AircraftClass;
  if (byType) out = byType;
  else if (byCategory) out = byCategory;
  else out = type ? 'jet' : 'unknown';
  if (MEMO.size > 4096) MEMO.clear();
  MEMO.set(key, out);
  return out;
}

/** Icon id for an aircraft's properties. */
export function aircraftIcon(properties: Readonly<Record<string, JsonValue>>): string {
  return AIRCRAFT_CLASS_ICON[aircraftClass(properties)];
}

/** Presentation classifies every aircraft on every pass it rebuilds; the answer depends on two short strings. */
const MEMO = new Map<string, AircraftClass>();

function str(v: JsonValue | undefined): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
