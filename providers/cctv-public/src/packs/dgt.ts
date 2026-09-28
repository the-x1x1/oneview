import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  invalidIdReason,
  isOnHost,
  offHostReason,
  type CatalogPack,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from './types.js';

/**
 * DGT (Dirección General de Tráfico, Spain) road cameras — the national traffic
 * authority's cameras on the state road network (every region but Catalonia and the
 * Basque Country, which run their own traffic services).
 *
 * Licence: Spain's National Access Point for traffic data (nap.dgt.es, the access point
 * the EU ITS delegated regulations require) lists DGT's "Mapa de tráfico" — the eTraffic
 * application at etraffic.dgt.es, which serves these images, tagged `camaras` — under
 * Creative Commons Attribution (http://www.opendefinition.org/licenses/cc-by), free of
 * charge (https://nap.dgt.es/en/dataset/mapa-de-trafico, read 2026-09-27). The NAP's own
 * camera dataset pages could not be read from the build machine (robots.txt), so the
 * pack is off by default until the integrator has looked at them; see the registry record.
 *
 * The camera list is the JSON the DGT's own camera page loads:
 * `{ camaras: [ { id, latitud, longitud, carretera, pk, sentido, provincia, imagen, fecha } ] }`
 * with coordinates as decimal strings and `imagen` a still at
 * `https://etraffic.dgt.es/camarasEtraffic/<id>.jpg` (checked 2026-09-27: the list answered
 * with at least 488 rows in the part read, and a still answered as an image). Only stills
 * under that directory are kept. `sentido` is the kilometre-post direction ("+", "-", "*"),
 * not a compass facing, so no heading is derived from it. `provincia` is the INE province
 * code. Some rows carry a `fecha` (last image time) months old; they are kept, since the
 * frame is fetched live and shows its own age.
 */
export const DGT_CAMERAS_URL = 'https://www.dgt.es/.content/.assets/json/camaras.json';
export const DGT_FRAME_PREFIX = 'etraffic.dgt.es/camarasEtraffic/';

export const dgtPack: CatalogPack = {
  id: 'dgt',
  registryId: 'dgt-etraffic-cameras',
  request: { url: DGT_CAMERAS_URL, headers: { Accept: 'application/json' }, maxBytes: 8 * 1024 * 1024 },
  frameHosts: [DGT_FRAME_PREFIX],
  offByDefault: true,
  attribution: 'Dirección General de Tráfico (DGT), Spain — eTraffic, CC BY (nap.dgt.es)',
  refreshSeconds: 180,
  normalize: normalizeDgt,
};

/** INE province codes (the `provincia` field) to names, for the camera's region line. */
const PROVINCES: Readonly<Record<string, string>> = Object.freeze({
  '01': 'Araba/Álava',
  '02': 'Albacete',
  '03': 'Alicante/Alacant',
  '04': 'Almería',
  '05': 'Ávila',
  '06': 'Badajoz',
  '07': 'Illes Balears',
  '08': 'Barcelona',
  '09': 'Burgos',
  '10': 'Cáceres',
  '11': 'Cádiz',
  '12': 'Castellón/Castelló',
  '13': 'Ciudad Real',
  '14': 'Córdoba',
  '15': 'A Coruña',
  '16': 'Cuenca',
  '17': 'Girona',
  '18': 'Granada',
  '19': 'Guadalajara',
  '20': 'Gipuzkoa',
  '21': 'Huelva',
  '22': 'Huesca',
  '23': 'Jaén',
  '24': 'León',
  '25': 'Lleida',
  '26': 'La Rioja',
  '27': 'Lugo',
  '28': 'Madrid',
  '29': 'Málaga',
  '30': 'Murcia',
  '31': 'Navarra',
  '32': 'Ourense',
  '33': 'Asturias',
  '34': 'Palencia',
  '35': 'Las Palmas',
  '36': 'Pontevedra',
  '37': 'Salamanca',
  '38': 'Santa Cruz de Tenerife',
  '39': 'Cantabria',
  '40': 'Segovia',
  '41': 'Sevilla',
  '42': 'Soria',
  '43': 'Tarragona',
  '44': 'Teruel',
  '45': 'Toledo',
  '46': 'Valencia/València',
  '47': 'Valladolid',
  '48': 'Bizkaia',
  '49': 'Zamora',
  '50': 'Zaragoza',
  '51': 'Ceuta',
  '52': 'Melilla',
});

interface DgtRow {
  id?: unknown;
  latitud?: unknown;
  longitud?: unknown;
  carretera?: unknown;
  pk?: unknown;
  provincia?: unknown;
  imagen?: unknown;
}

export function normalizeDgt(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  const rows = (payload as { camaras?: unknown } | null)?.camaras;
  if (!Array.isArray(rows))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'no camaras array' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  rows.forEach((raw: unknown, index: number) => {
    const row = raw as DgtRow;
    if (!row || typeof row !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const cameraId = typeof row.id === 'number' ? String(row.id) : text(row.id, 64);
    if (!CAMERA_ID_PATTERN.test(cameraId)) {
      rejected.push({ index, reason: invalidIdReason(row.id) });
      return;
    }
    const lat = num(row.latitud);
    const lon = num(row.longitud);
    if (!isValidLatLon(lat, lon) || !isLikelySpain(lat, lon)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const frameUrl = text(row.imagen, 300).replace(/^http:\/\//i, 'https://');
    if (!isOnHost(frameUrl, dgtPack.frameHosts)) {
      rejected.push({ index, reason: offHostReason(frameUrl) });
      return;
    }
    if (seen.has(cameraId)) {
      rejected.push({ index, reason: `duplicate id ${cameraId}` });
      return;
    }
    seen.add(cameraId);
    const road = text(row.carretera, 30);
    const pk = text(typeof row.pk === 'number' ? String(row.pk) : row.pk, 12);
    const code = text(typeof row.provincia === 'number' ? String(row.provincia) : row.provincia, 4).padStart(2, '0');
    const province = PROVINCES[code];
    drafts.push(
      draftFromCamera(
        dgtPack,
        {
          pack: 'dgt',
          cameraId,
          name: road ? `${road}${pk ? ` km ${pk}` : ''}` : `DGT camera ${cameraId}`,
          latitude: lat,
          longitude: lon,
          region: province ? `${province}, Spain` : 'Spain',
          frameUrl,
          ...(road ? { extra: { roadway: road } } : {}),
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: rows.length, rejected };
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
}

/** Peninsula, the Balearic and Canary Islands, Ceuta and Melilla. */
function isLikelySpain(lat: number, lon: number): boolean {
  return lat >= 27.4 && lat <= 44 && lon >= -18.4 && lon <= 4.6;
}
