/**
 * What a satellite is for, as far as the catalogue says: one category per object, carried as
 * `payload.satelliteCategory` so the map can colour satellites apart and the context panel
 * can name the category.
 *
 * Three sources, most specific first:
 *
 *  1. CelesTrak's own lists. The `military` ("Miscellaneous Military") and `gnss` (every
 *     navigation constellation: GPS, GLONASS, Galileo, BeiDou, QZSS, NavIC) groups are small
 *     — a few hundred objects between them — and are fetched alongside the configured groups,
 *     on the same two-hour catalogue cadence (CATEGORY_GROUPS; two requests every two hours).
 *     A satellite in one of them is what CelesTrak says it is; nothing here guesses at
 *     which satellites are military.
 *  2. The group the satellite was fetched in, when the operator chose a themed group
 *     (`stations`, `starlink`, `gps-ops`, `weather`, `science`).
 *  3. Its name, for the well-known constellations and missions whose names say what they
 *     are (STARLINK-1234, NOAA 19, SENTINEL-2A, HST). The keyword lists follow OSIRIS's
 *     satellite route (MIT, `MISSION_CLASSIFY`) and CelesTrak's group pages; a name matches
 *     on whole words only, so "GPS" does not match "GPSAT".
 *
 * Anything else is `other` — an honest "not known", not a guess.
 */
export const SATELLITE_CATEGORIES = [
  'station',
  'starlink',
  'comms',
  'navigation',
  'weather',
  'earth-observation',
  'science',
  'military',
  'rocket-body',
  'debris',
  'other',
] as const;
export type SatelliteCategory = (typeof SATELLITE_CATEGORIES)[number];

/** The extra CelesTrak groups whose membership decides a category (see above). */
export const CATEGORY_GROUPS = ['military', 'gnss'] as const;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

/** A satellite's category from its own name alone (step 3), or undefined when the name says nothing. */
export function categoryFromName(name: string): SatelliteCategory | undefined {
  const n = ` ${name.toUpperCase().replace(/[()[\],]/g, ' ')} `;
  const has = (words: readonly string[]) => words.some((w) => new RegExp(`[\\s/-]${escape(w)}(?=[\\s/-]|\\d)`).test(n));
  if (/\sDEB(\s|$)/.test(n)) return 'debris';
  if (/\sR\/B(\s|$)/.test(n)) return 'rocket-body';
  if (has(STATION_WORDS)) return 'station';
  if (has(['STARLINK'])) return 'starlink';
  if (has(NAVIGATION_WORDS)) return 'navigation';
  if (has(WEATHER_WORDS)) return 'weather';
  if (has(EARTH_OBSERVATION_WORDS)) return 'earth-observation';
  if (has(SCIENCE_WORDS)) return 'science';
  if (has(MILITARY_WORDS)) return 'military';
  if (has(COMMS_WORDS)) return 'comms';
  return undefined;
}

/** Themed CelesTrak groups (step 2). `active`, `visual` and `geo` say nothing about purpose. */
const GROUP_CATEGORY: Readonly<Record<string, SatelliteCategory>> = {
  stations: 'station',
  starlink: 'starlink',
  'gps-ops': 'navigation',
  gnss: 'navigation',
  weather: 'weather',
  science: 'science',
  military: 'military',
};

/**
 * The category for one satellite. `memberOf` answers whether CelesTrak lists it in one of
 * CATEGORY_GROUPS (undefined while those lists are not loaded); `group` is the group it was
 * fetched in.
 */
export function satelliteCategory(
  e: { noradId: number; name: string },
  group: string,
  memberOf?: (group: CategoryGroup, noradId: number) => boolean,
): SatelliteCategory {
  const byName = categoryFromName(e.name);
  // A piece of debris or a spent stage is that, whatever list it is on.
  if (byName === 'debris' || byName === 'rocket-body') return byName;
  if (byName === 'station' || group === 'stations') return 'station';
  if (memberOf?.('military', e.noradId)) return 'military';
  if (memberOf?.('gnss', e.noradId)) return 'navigation';
  return GROUP_CATEGORY[group] ?? byName ?? 'other';
}

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const STATION_WORDS = ['ISS', 'ZARYA', 'TIANGONG', 'TIANHE', 'WENTIAN', 'MENGTIAN', 'CSS'];
const NAVIGATION_WORDS = ['NAVSTAR', 'GPS', 'GLONASS', 'GALILEO', 'GSAT0', 'BEIDOU', 'QZS', 'IRNSS', 'NVS'];
const WEATHER_WORDS = [
  'NOAA',
  'GOES',
  'METEOSAT',
  'METOP',
  'FENGYUN',
  'FY-3',
  'FY-4',
  'HIMAWARI',
  'METEOR-M',
  'ELEKTRO-L',
  'GK-2A',
  'DMSP',
  'JPSS',
  'SUOMI',
  'INSAT-3D',
  'INSAT-3DR',
];
const EARTH_OBSERVATION_WORDS = [
  'LANDSAT',
  'SENTINEL',
  'TERRA',
  'AQUA',
  'WORLDVIEW',
  'PLEIADES',
  'SPOT',
  'FLOCK',
  'SKYSAT',
  'ICEYE',
  'CAPELLA',
  'RADARSAT',
  'GAOFEN',
  'JILIN',
  'CARTOSAT',
  'RESURS',
  'KOMPSAT',
  'SUPERVIEW',
];
const SCIENCE_WORDS = [
  'HST',
  'HUBBLE',
  'SWIFT',
  'FERMI',
  'NUSTAR',
  'TESS',
  'CXO',
  'XMM',
  'INTEGRAL',
  'AGILE',
  'CHEOPS',
];
/** Names only governments give: a US government payload is "USA 123"; NROL launches, Yaogan. */
const MILITARY_WORDS = ['USA', 'NROL', 'YAOGAN', 'SBIRS', 'AEHF', 'MUOS', 'WGS'];
const COMMS_WORDS = [
  'ONEWEB',
  'IRIDIUM',
  'GLOBALSTAR',
  'ORBCOMM',
  'INTELSAT',
  'SES',
  'EUTELSAT',
  'TELESAT',
  'QIANFAN',
  'KUIPER',
  'VIASAT',
  'INMARSAT',
  'O3B',
  'TDRS',
  'ECHOSTAR',
  'SIRIUS',
  'ASTRA',
  'HULIANWANG',
];
