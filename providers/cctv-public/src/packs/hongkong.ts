import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import {
  CAMERA_ID_PATTERN,
  draftFromCamera,
  invalidIdReason,
  type CatalogPack,
  type PackNormalizeOptions,
  type PackNormalizeResult,
} from './types.js';

/**
 * Hong Kong Transport Department traffic snapshots — DATA.GOV.HK Terms and Conditions
 * (browse, download, distribute and reproduce the data for commercial and non-commercial
 * purposes free of charge, with attribution to the Government, the Relevant Organisation
 * and DATA.GOV.HK). About a thousand cameras, refreshed every two minutes.
 *
 * The catalogue is a flat XML list: `<image><key/><region/><district/><description/>
 * <easting/><northing/><latitude/><longitude/><url/></image>`. It is read with a small
 * extractor for exactly that shape rather than a general XML parser: no attributes,
 * namespaces, entities beyond the five predefined ones, or nesting are needed, and none
 * are accepted. The frame URL is rebuilt from the validated key on the Transport
 * Department's image host (`https://tdcctv.data.one.gov.hk/<key>.JPG`), never taken as given.
 * There is no facing in the catalogue.
 */
export const HONG_KONG_CAMERAS_URL =
  'https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml';
export const HONG_KONG_FRAME_HOST = 'tdcctv.data.one.gov.hk';

export const hongKongPack: CatalogPack = {
  id: 'hongkong',
  registryId: 'hk-td-traffic-snapshots',
  request: { url: HONG_KONG_CAMERAS_URL, headers: { Accept: 'application/xml, text/xml' }, maxBytes: 4 * 1024 * 1024 },
  format: 'text',
  frameHosts: [HONG_KONG_FRAME_HOST],
  attribution: 'Transport Department, the Government of the Hong Kong SAR — DATA.GOV.HK',
  refreshSeconds: 120,
  normalize: normalizeHongKong,
};

const KEY = /^[A-Z0-9]{2,12}$/;

/** `<image>…</image>` blocks as flat `{ tag: text }` records. */
export function parseFlatXmlRecords(xml: string, recordTag: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const block = new RegExp(`<${recordTag}>([\\s\\S]*?)</${recordTag}>`, 'g');
  const field = /<([A-Za-z_][\w-]{0,40})>([^<]*)<\/\1>/g;
  for (const m of xml.matchAll(block)) {
    const rec: Record<string, string> = {};
    for (const f of m[1]!.matchAll(field)) rec[f[1]!] = decodeEntities(f[2]!).trim();
    out.push(rec);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function normalizeHongKong(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  if (typeof payload !== 'string' || !/<image-list[\s>]/.test(payload))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not an image-list document' }], malformed: true };
  const records = parseFlatXmlRecords(payload, 'image');
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  records.forEach((r, index) => {
    const key = (r['key'] ?? '').toUpperCase();
    if (!KEY.test(key) || !CAMERA_ID_PATTERN.test(key)) {
      rejected.push({ index, reason: invalidIdReason(r['key']) });
      return;
    }
    const lat = Number(r['latitude']);
    const lon = Number(r['longitude']);
    if (!isValidLatLon(lat, lon) || !isLikelyHongKong(lat, lon)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    if (seen.has(key)) {
      rejected.push({ index, reason: `duplicate id ${key}` });
      return;
    }
    seen.add(key);
    // "Aberdeen Praya Road near Fish Market [H429F]": the key is already the id.
    const description = (r['description'] ?? '').replace(/\s*\[[A-Z0-9]+\]\s*$/, '').slice(0, 140);
    const district = (r['district'] ?? '').slice(0, 60);
    drafts.push(
      draftFromCamera(
        hongKongPack,
        {
          pack: 'hongkong',
          cameraId: key,
          name: description || `Hong Kong camera ${key}`,
          latitude: lat,
          longitude: lon,
          region: [district, r['region']].filter(Boolean).join(', ').slice(0, 80) || 'Hong Kong',
          frameUrl: `https://${HONG_KONG_FRAME_HOST}/${key}.JPG`,
        },
        opts,
        r as unknown as JsonValue,
      ),
    );
  });
  return { drafts, total: records.length, rejected };
}

function isLikelyHongKong(lat: number, lon: number): boolean {
  return lat >= 22.1 && lat <= 22.6 && lon >= 113.8 && lon <= 114.5;
}
