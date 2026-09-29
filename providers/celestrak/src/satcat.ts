import type { JsonValue } from '@worldview/world-model';

/**
 * CelesTrak SATCAT — the satellite catalogue record for one object: who owns it, when and
 * where it was launched, what kind of object it is, whether it is still working and whether
 * it has come down. Read for the selected satellite only (the provider's `objectDetails`).
 *
 * Why one record at a time rather than the whole catalogue: the bulk file (satcat.csv) is
 * every object ever catalogued, some 65,000 rows, several megabytes a day for the handful the
 * operator actually looks at. The query API answers one NORAD number with one small record,
 * and each answer is kept a day (the catalogue changes by launches and decays, not by the
 * hour). Format: https://celestrak.org/satcat/satcat-format.php — the JSON record carries
 * OBJECT_NAME, OBJECT_ID, NORAD_CAT_ID, OBJECT_TYPE, OPS_STATUS_CODE, OWNER, LAUNCH_DATE,
 * LAUNCH_SITE, DECAY_DATE, PERIOD, INCLINATION, APOGEE, PERIGEE, RCS, DATA_STATUS_CODE,
 * ORBIT_CENTER, ORBIT_TYPE.
 *
 * The parser is defensive about types (a number may come as a number or a numeric string;
 * an empty value as null, "" or absent), because the live response could not be fetched
 * from the environment this was written in; the fixtures in satcat.test.ts are hand-written
 * in the documented shape and labelled as such.
 */
export const SATCAT_RECORDS_URL = 'https://celestrak.org/satcat/records.php';

export function satcatUrl(noradId: number): string {
  return `${SATCAT_RECORDS_URL}?CATNR=${encodeURIComponent(String(noradId))}&FORMAT=JSON`;
}

export interface SatcatRecord {
  noradId: number;
  name?: string;
  intlDesignator?: string;
  /** PAY, R/B, DEB, UNK. */
  objectType?: string;
  /** +, -, P, B, S, X, D, ? */
  opsStatus?: string;
  /** CelesTrak's owner/source code (US, PRC, CIS, ESA, ISS…). */
  owner?: string;
  launchDate?: string;
  /** CelesTrak's launch site code (AFETR, TYMSC…). */
  launchSite?: string;
  decayDate?: string;
  periodMinutes?: number;
  inclination?: number;
  apogeeKm?: number;
  perigeeKm?: number;
  rcsM2?: number;
  /** NCE, NIE, NEA — why there are no current elements, when there are none. */
  dataStatus?: string;
  /** EA (Earth), MO, SU…, or the NORAD number of the object it is docked to. */
  orbitCenter?: string;
  /** ORB, LAN, IMP, DOC, R/T. */
  orbitType?: string;
}

/** CelesTrak OBJECT_TYPE codes (satcat-format.php). */
export const OBJECT_TYPE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  PAY: 'Payload',
  'R/B': 'Rocket body',
  DEB: 'Debris',
  UNK: 'Unknown',
});

/** CelesTrak operational status codes (satcat/status.php). */
export const OPS_STATUS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  '+': 'Operational',
  '-': 'Nonoperational',
  P: 'Partially operational',
  B: 'Backup / standby',
  S: 'Spare',
  X: 'Extended mission',
  D: 'Decayed',
  '?': 'Unknown',
});

/** CelesTrak ORBIT_TYPE codes. */
export const ORBIT_TYPE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  ORB: 'In orbit',
  LAN: 'Landed',
  IMP: 'Impacted',
  DOC: 'Docked',
  'R/T': 'Round trip',
});

/** CelesTrak DATA_STATUS_CODE values. */
export const DATA_STATUS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  NCE: 'No current elements',
  NIE: 'No initial elements',
  NEA: 'No elements available',
});

/**
 * CelesTrak owner/source codes (satcat/sources.php), the name each stands for. The codes are
 * CelesTrak's own and are facts about the catalogue; a code not listed is shown as the code.
 */
export const OWNER_TEXT: Readonly<Record<string, string>> = Object.freeze({
  AB: 'Arab Satellite Communications Organization',
  ABS: 'Asia Broadcast Satellite',
  AC: 'Asia Satellite Telecommunications Company (AsiaSat)',
  ALG: 'Algeria',
  ANG: 'Angola',
  ARGN: 'Argentina',
  ARM: 'Armenia',
  ASRA: 'Austria',
  AUS: 'Australia',
  AZER: 'Azerbaijan',
  BEL: 'Belgium',
  BELA: 'Belarus',
  BERM: 'Bermuda',
  BGD: 'Bangladesh',
  BHR: 'Bahrain',
  BHUT: 'Bhutan',
  BOL: 'Bolivia',
  BRAZ: 'Brazil',
  BUL: 'Bulgaria',
  BWA: 'Botswana',
  CA: 'Canada',
  CHBZ: 'China / Brazil',
  CHTU: 'China / Türkiye',
  CHLE: 'Chile',
  CIS: 'Commonwealth of Independent States (former USSR)',
  COL: 'Colombia',
  CRI: 'Costa Rica',
  CZCH: 'Czech Republic (former Czechoslovakia)',
  DEN: 'Denmark',
  DJI: 'Djibouti',
  ECU: 'Ecuador',
  EGYP: 'Egypt',
  ESA: 'European Space Agency',
  ESRO: 'European Space Research Organization',
  EST: 'Estonia',
  ETH: 'Ethiopia',
  EUME: 'EUMETSAT',
  EUTE: 'EUTELSAT',
  FGER: 'France / Germany',
  FIN: 'Finland',
  FR: 'France',
  FRIT: 'France / Italy',
  GER: 'Germany',
  GHA: 'Ghana',
  GLOB: 'Globalstar',
  GREC: 'Greece',
  GRSA: 'Greece / Saudi Arabia',
  GUAT: 'Guatemala',
  HRV: 'Croatia',
  HUN: 'Hungary',
  IM: 'INMARSAT',
  IND: 'India',
  INDO: 'Indonesia',
  IRAN: 'Iran',
  IRAQ: 'Iraq',
  IRID: 'Iridium',
  IRL: 'Ireland',
  ISRA: 'Israel',
  ISRO: 'Indian Space Research Organisation',
  ISS: 'International Space Station partners',
  IT: 'Italy',
  ITSO: 'INTELSAT',
  JPN: 'Japan',
  KAZ: 'Kazakhstan',
  KEN: 'Kenya',
  LAOS: 'Laos',
  LKA: 'Sri Lanka',
  LTU: 'Lithuania',
  LUXE: 'Luxembourg',
  MA: 'Morocco',
  MALA: 'Malaysia',
  MCO: 'Monaco',
  MDA: 'Moldova',
  MEX: 'Mexico',
  MMR: 'Myanmar',
  MNE: 'Montenegro',
  MNG: 'Mongolia',
  MUS: 'Mauritius',
  NATO: 'North Atlantic Treaty Organization',
  NETH: 'Netherlands',
  NICO: 'New ICO',
  NIG: 'Nigeria',
  NKOR: "Democratic People's Republic of Korea",
  NOR: 'Norway',
  NPL: 'Nepal',
  NZ: 'New Zealand',
  O3B: 'O3b Networks',
  ORB: 'ORBCOMM',
  PAKI: 'Pakistan',
  PERU: 'Peru',
  POL: 'Poland',
  POR: 'Portugal',
  PRC: "People's Republic of China",
  PRY: 'Paraguay',
  PRES: "People's Republic of China / European Space Agency",
  QAT: 'Qatar',
  RASC: 'RascomStar-QAF',
  ROC: 'Taiwan (Republic of China)',
  ROM: 'Romania',
  RP: 'Philippines',
  RWA: 'Rwanda',
  SAFR: 'South Africa',
  SAUD: 'Saudi Arabia',
  SDN: 'Sudan',
  SEAL: 'Sea Launch',
  SEN: 'Senegal',
  SES: 'SES',
  SGJP: 'Singapore / Japan',
  SING: 'Singapore',
  SKOR: 'Republic of Korea',
  SLB: 'Solomon Islands',
  SPN: 'Spain',
  STCT: 'Singapore / Taiwan',
  SVN: 'Slovenia',
  SWED: 'Sweden',
  SWTZ: 'Switzerland',
  TBD: 'To be determined',
  THAI: 'Thailand',
  TMMC: 'Turkmenistan / Monaco',
  TUN: 'Tunisia',
  TURK: 'Türkiye',
  UAE: 'United Arab Emirates',
  UK: 'United Kingdom',
  UKR: 'Ukraine',
  UNK: 'Unknown',
  URY: 'Uruguay',
  US: 'United States',
  USBZ: 'United States / Brazil',
  VAT: 'Vatican City State',
  VENZ: 'Venezuela',
  VTNM: 'Vietnam',
  ZWE: 'Zimbabwe',
});

/** CelesTrak launch site codes (satcat/launchsites.php). */
export const LAUNCH_SITE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  AFETR: 'Eastern Range (Cape Canaveral / Kennedy), Florida, USA',
  AFWTR: 'Western Range (Vandenberg), California, USA',
  ANDSP: 'Andøya Spaceport, Norway',
  ALCLC: 'Alcântara Launch Center, Brazil',
  BOS: 'Bowen Orbital Spaceport, Queensland, Australia',
  CAS: 'Canaries airspace (air launch)',
  DLS: 'Dombarovskiy, Russia',
  ERAS: 'Eastern Range airspace (air launch)',
  FRGUI: "Europe's Spaceport, Kourou, French Guiana",
  HGSTR: 'Hammaguira, Algeria',
  JJSLA: 'Jeju Island sea launch area, Republic of Korea',
  JSC: 'Jiuquan Satellite Launch Center, China',
  KODAK: 'Kodiak Launch Complex, Alaska, USA',
  KSCUT: 'Uchinoura Space Center, Japan',
  KWAJ: 'Kwajalein Atoll (US Army)',
  KYMSC: 'Kapustin Yar, Russia',
  NSC: 'Naro Space Center, Republic of Korea',
  PLMSC: 'Plesetsk Cosmodrome, Russia',
  RLLB: 'Rocket Lab Launch Complex, Mahia, New Zealand',
  SCSLA: 'South China Sea launch area, China',
  SEAL: 'Sea Launch platform (mobile)',
  SEMLS: 'Semnan, Iran',
  SMTS: 'Shahrud, Iran',
  SNMLP: 'San Marco platform, Kenya',
  SPKII: 'Space Port Kii, Japan',
  SRILR: 'Satish Dhawan Space Centre, Sriharikota, India',
  SUBL: 'Submarine launch (mobile)',
  SVOBO: 'Svobodnyy, Russia',
  TAISC: 'Taiyuan Satellite Launch Center, China',
  TANSC: 'Tanegashima Space Center, Japan',
  TYMSC: 'Baikonur Cosmodrome (Tyuratam), Kazakhstan',
  UNK: 'Unknown',
  VOSTO: 'Vostochny Cosmodrome, Russia',
  WLPIS: 'Wallops Island, Virginia, USA',
  WOMRA: 'Woomera, Australia',
  WRAS: 'Western Range airspace (air launch)',
  WSC: 'Wenchang Space Launch Site, China',
  XICLF: 'Xichang Satellite Launch Center, China',
  YAVNE: 'Palmachim / Yavne, Israel',
  YSLA: 'Yellow Sea launch area, China',
  YUN: 'Sohae (Yunsong), North Korea',
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z0-9/+?-]{1,8}$/;

function field(r: Record<string, unknown>, key: string): unknown {
  const v = r[key];
  return v === null || v === '' ? undefined : v;
}

function numberField(r: Record<string, unknown>, key: string): number | undefined {
  const v = field(r, key);
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function textField(r: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = field(r, key);
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const t = String(v).trim();
  return t ? t.slice(0, max) : undefined;
}

function codeField(r: Record<string, unknown>, key: string): string | undefined {
  const t = textField(r, key, 16)?.toUpperCase();
  return t && CODE.test(t) ? t : undefined;
}

function dateField(r: Record<string, unknown>, key: string): string | undefined {
  const t = textField(r, key, 10);
  return t && DATE.test(t) && Number.isFinite(Date.parse(`${t}T00:00:00Z`)) ? t : undefined;
}

/**
 * The record for `noradId` from a SATCAT query answer (a JSON array of records), or
 * undefined when the answer holds none for that number. Anything that is not the documented
 * shape is ignored field by field rather than failing the record.
 */
export function parseSatcatRecords(body: unknown, noradId: number): SatcatRecord | undefined {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (numberField(r, 'NORAD_CAT_ID') !== noradId) continue;
    const out: SatcatRecord = { noradId };
    const set = <K extends keyof SatcatRecord>(k: K, v: SatcatRecord[K] | undefined) => {
      if (v !== undefined) out[k] = v;
    };
    set('name', textField(r, 'OBJECT_NAME', 60));
    set('intlDesignator', textField(r, 'OBJECT_ID', 16));
    set('objectType', codeField(r, 'OBJECT_TYPE'));
    set('opsStatus', codeField(r, 'OPS_STATUS_CODE'));
    set('owner', codeField(r, 'OWNER'));
    set('launchDate', dateField(r, 'LAUNCH_DATE'));
    set('launchSite', codeField(r, 'LAUNCH_SITE'));
    set('decayDate', dateField(r, 'DECAY_DATE'));
    const positive = (v: number | undefined) => (v !== undefined && v > 0 ? v : undefined);
    set('periodMinutes', positive(numberField(r, 'PERIOD')));
    const inc = numberField(r, 'INCLINATION');
    set('inclination', inc !== undefined && inc >= 0 && inc <= 180 ? inc : undefined);
    set('apogeeKm', numberField(r, 'APOGEE'));
    set('perigeeKm', numberField(r, 'PERIGEE'));
    set('rcsM2', positive(numberField(r, 'RCS')));
    set('dataStatus', codeField(r, 'DATA_STATUS_CODE'));
    set('orbitCenter', codeField(r, 'ORBIT_CENTER'));
    set('orbitType', codeField(r, 'ORBIT_TYPE'));
    return out;
  }
  return undefined;
}

/**
 * The record as context-panel properties, codes spelled out: `owner` stays the code and
 * `ownerName` says what it stands for, and so on. Only what the record carries is written.
 */
export function satcatProperties(r: SatcatRecord): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { satcatNoradId: r.noradId };
  const put = (k: string, v: JsonValue | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  put('satcatName', r.name);
  put('satcatIntlDesignator', r.intlDesignator);
  put('objectType', r.objectType);
  put('objectTypeText', r.objectType ? OBJECT_TYPE_TEXT[r.objectType] : undefined);
  put('opsStatus', r.opsStatus);
  put('opsStatusText', r.opsStatus ? OPS_STATUS_TEXT[r.opsStatus] : undefined);
  put('owner', r.owner);
  put('ownerName', r.owner ? OWNER_TEXT[r.owner] : undefined);
  put('launchDate', r.launchDate);
  put('launchSite', r.launchSite);
  put('launchSiteName', r.launchSite ? LAUNCH_SITE_TEXT[r.launchSite] : undefined);
  put('decayDate', r.decayDate);
  put('satcatPeriodMinutes', r.periodMinutes);
  put('satcatInclination', r.inclination);
  put('satcatApogeeKm', r.apogeeKm);
  put('satcatPerigeeKm', r.perigeeKm);
  put('rcsM2', r.rcsM2);
  put('dataStatusText', r.dataStatus ? DATA_STATUS_TEXT[r.dataStatus] : undefined);
  put('orbitTypeText', r.orbitType ? ORBIT_TYPE_TEXT[r.orbitType] : undefined);
  if (r.orbitCenter && /^\d+$/.test(r.orbitCenter)) put('dockedTo', Number(r.orbitCenter));
  return out;
}

/** What the cache keeps per object: the record, or that SATCAT had none. */
export type SatcatCacheEntry = { record: SatcatRecord } | { none: true };

export function restoreSatcatEntry(value: JsonValue, noradId: number): SatcatCacheEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, JsonValue>;
  if (v['none'] === true) return { none: true };
  const rec = v['record'];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return undefined;
  // Stored in our own field names; re-validated through the same field rules.
  const r = rec as Record<string, JsonValue>;
  const back = parseSatcatRecords(
    [
      {
        NORAD_CAT_ID: r['noradId'] ?? null,
        OBJECT_NAME: r['name'] ?? null,
        OBJECT_ID: r['intlDesignator'] ?? null,
        OBJECT_TYPE: r['objectType'] ?? null,
        OPS_STATUS_CODE: r['opsStatus'] ?? null,
        OWNER: r['owner'] ?? null,
        LAUNCH_DATE: r['launchDate'] ?? null,
        LAUNCH_SITE: r['launchSite'] ?? null,
        DECAY_DATE: r['decayDate'] ?? null,
        PERIOD: r['periodMinutes'] ?? null,
        INCLINATION: r['inclination'] ?? null,
        APOGEE: r['apogeeKm'] ?? null,
        PERIGEE: r['perigeeKm'] ?? null,
        RCS: r['rcsM2'] ?? null,
        DATA_STATUS_CODE: r['dataStatus'] ?? null,
        ORBIT_CENTER: r['orbitCenter'] ?? null,
        ORBIT_TYPE: r['orbitType'] ?? null,
      },
    ],
    noradId,
  );
  return back ? { record: back } : undefined;
}

export function satcatEntryToJson(entry: SatcatCacheEntry): JsonValue {
  if ('none' in entry) return { none: true };
  const rec: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(entry.record)) if (v !== undefined) rec[k] = v as JsonValue;
  return { record: rec };
}
