import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import { directionToHeading } from '../direction.js';
import { parseFlatXmlRecords } from './hongkong.js';
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
 * Taiwan's road cameras — the Ministry of Transportation and Communications' two highway
 * authorities, each publishing its CCTV list as open data under the Open Government Data
 * License, version 1.0 (政府資料開放授權條款－第1版; Open Definition conformant: use for any
 * purpose, including commercial, with attribution):
 *
 *  - Highway Bureau (公路局, provincial highways): data.gov.tw dataset 29817,
 *    `thbapp.thb.gov.tw/opendata/cctv/info/cctvs.xml`;
 *  - Freeway Bureau (高速公路局, national freeways): data.gov.tw dataset 37665,
 *    `tisvcloud.freeway.gov.tw/history/motc20/CCTV.xml`.
 *
 * Both lists follow MOTC's traffic data standard (namespace
 * `http://traffic.transportdata.tw/standard/traffic/schema/`): a `<CCTVList>` of flat
 * `<CCTV>` records with `CCTVID`, `PositionLon`/`PositionLat`, `VideoStreamURL` (the
 * camera's live MJPEG stream), `VideoImageURL` (a still, where the authority serves one),
 * `SurveillanceDescription`, `RoadName`, `RoadDirection` and `LocationMile`. These are
 * the only packs with live video for every camera: the Live view plays the MJPEG stream
 * itself. Where no still is published the camera gateway takes the stream's first frame.
 *
 * Read with the same flat-record extractor as Hong Kong's list (no attributes, entities
 * beyond the predefined five, or nesting inside a record are needed or accepted). Stream and
 * image URLs are taken from the list only when they are https on the authority's own hosts;
 * an `http:` URL on those hosts is upgraded, because both serve https.
 */
export const TAIWAN_THB_CCTV_URL = 'https://thbapp.thb.gov.tw/opendata/cctv/info/cctvs.xml';
export const TAIWAN_FREEWAY_CCTV_URL = 'https://tisvcloud.freeway.gov.tw/history/motc20/CCTV.xml';

/** The Highway Bureau's stream servers (`cctv-ss02.thb.gov.tw` in the list checked 2026-09-23). */
export const TAIWAN_THB_MEDIA_HOSTS: readonly string[] = Object.freeze(
  Array.from({ length: 12 }, (_, i) => `cctv-ss${String(i + 1).padStart(2, '0')}.thb.gov.tw`),
);
/** The Freeway Bureau's MJPEG servers. */
export const TAIWAN_FREEWAY_MEDIA_HOSTS: readonly string[] = Object.freeze([
  'cctvn.freeway.gov.tw',
  'cctvc.freeway.gov.tw',
  'cctvs.freeway.gov.tw',
  'cctv.freeway.gov.tw',
  'cctvn1.freeway.gov.tw',
  'cctvn2.freeway.gov.tw',
]);

const OGDL = 'Open Government Data License, version 1.0';

export const taiwanHighwayPack: CatalogPack = {
  id: 'taiwan-thb',
  registryId: 'tw-thb-cctv',
  request: {
    url: TAIWAN_THB_CCTV_URL,
    headers: { Accept: 'application/xml, text/xml' },
    maxBytes: 8 * 1024 * 1024,
  },
  format: 'text',
  frameHosts: TAIWAN_THB_MEDIA_HOSTS,
  streamHosts: TAIWAN_THB_MEDIA_HOSTS,
  attribution: `Highway Bureau, MOTC (Taiwan) — ${OGDL}`,
  refreshSeconds: 30,
  normalize: (payload, opts) => normalizeMotcCctv(taiwanHighwayPack, payload, opts),
};

export const taiwanFreewayPack: CatalogPack = {
  id: 'taiwan-freeway',
  registryId: 'tw-freeway-cctv',
  request: {
    url: TAIWAN_FREEWAY_CCTV_URL,
    headers: { Accept: 'application/xml, text/xml' },
    maxBytes: 16 * 1024 * 1024,
    // A few megabytes from a slow server: the default ten seconds timed out on the operator's
    // machine (2026-09-23) while every other catalogue answered.
    timeoutMs: 60_000,
  },
  format: 'text',
  frameHosts: TAIWAN_FREEWAY_MEDIA_HOSTS,
  streamHosts: TAIWAN_FREEWAY_MEDIA_HOSTS,
  attribution: `Freeway Bureau, MOTC (Taiwan) — ${OGDL}`,
  refreshSeconds: 30,
  normalize: (payload, opts) => normalizeMotcCctv(taiwanFreewayPack, payload, opts),
};

/** `http:` on one of the pack's own hosts → `https:`; anything else as given (and then checked). */
function httpsOnHost(url: string, hosts: readonly string[]): string {
  const m = /^http:\/\/([^/:?#]+)(.*)$/i.exec(url);
  if (m && hosts.some((h) => h.toLowerCase() === m[1]!.toLowerCase())) return `https://${m[1]}${m[2]}`;
  return url;
}

/** `CCTV-14-0620-009-002`: ids are ASCII; longer or stranger ones are refused. */
const ID = /^[A-Za-z0-9._-]{1,64}$/;

export function normalizeMotcCctv(
  pack: CatalogPack,
  payload: unknown,
  opts: PackNormalizeOptions,
): PackNormalizeResult {
  if (typeof payload !== 'string' || !/<CCTVList[\s>]/.test(payload))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not a CCTVList document' }], malformed: true };
  const records = parseFlatXmlRecords(payload, 'CCTV');
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  const hosts = pack.streamHosts ?? pack.frameHosts;
  records.forEach((r, index) => {
    const id = (r['CCTVID'] ?? '').trim();
    if (!ID.test(id) || !CAMERA_ID_PATTERN.test(id)) {
      rejected.push({ index, reason: invalidIdReason(r['CCTVID']) });
      return;
    }
    const lat = Number(r['PositionLat']);
    const lon = Number(r['PositionLon']);
    if (!isValidLatLon(lat, lon) || !isLikelyTaiwan(lat, lon)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    const stream = httpsOnHost((r['VideoStreamURL'] ?? '').trim(), hosts);
    const image = httpsOnHost((r['VideoImageURL'] ?? '').trim(), hosts);
    const hasStream = isOnHost(stream, pack.streamHosts ?? []);
    const hasImage = isOnHost(image, pack.frameHosts);
    if (!hasStream && !hasImage) {
      rejected.push({ index, reason: offHostReason(stream || image) });
      return;
    }
    if (seen.has(id)) {
      rejected.push({ index, reason: `duplicate id ${id}` });
      return;
    }
    seen.add(id);
    const road = (r['RoadName'] ?? '').slice(0, 40);
    const mile = (r['LocationMile'] ?? '').slice(0, 20);
    const where = (r['SurveillanceDescription'] ?? '').slice(0, 120);
    const direction = (r['RoadDirection'] ?? '').trim().slice(0, 4);
    const heading = directionToHeading(direction);
    drafts.push(
      draftFromCamera(
        pack,
        {
          pack: pack.id,
          cameraId: id,
          name: where || [road, mile].filter(Boolean).join(' ') || `Camera ${id}`,
          latitude: lat,
          longitude: lon,
          region: [road, mile].filter(Boolean).join(' ') || 'Taiwan',
          ...(heading !== undefined ? { headingDegrees: heading, direction } : {}),
          // No still published: the gateway takes the stream's first frame (`frameFromStream`).
          frameUrl: hasImage ? image : stream,
          ...(hasStream ? { stream: { url: stream, kind: 'mjpeg' as const } } : {}),
          ...(hasImage ? {} : { extra: { frameFromStream: true } }),
        },
        opts,
        r as unknown as JsonValue,
      ),
    );
  });
  return { drafts, total: records.length, rejected };
}

function isLikelyTaiwan(lat: number, lon: number): boolean {
  // Taiwan, Penghu, Kinmen and Matsu.
  return lat >= 21.8 && lat <= 26.5 && lon >= 118.0 && lon <= 122.2;
}
