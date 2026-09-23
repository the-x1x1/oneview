import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import { directionToHeading } from '../direction.js';
import { draftFromCamera, type CatalogPack, type PackNormalizeOptions, type PackNormalizeResult } from './types.js';

/**
 * DriveBC highway cameras (Government of British Columbia) — Open Government Licence –
 * British Columbia. Adapted from gods-eye-view server/providers/cctv/sources.js (MIT),
 * loadDriveBcSourcesFromOpenData.
 *
 * The keyless camera list served by DriveBC.ca (the DataBC HighwayCams CSV lists the same
 * cameras but still carries retired frame URLs). Only cameras that are switched on and
 * published (`is_on`, `should_appear`) with a positive integer id are kept. Frame URLs are
 * built from that id on www.drivebc.ca and never read from the payload. `orientation` is
 * one of the eight compass points and becomes the heading; `elevation` is metres above sea
 * level. Some cameras are supplied by partners (TransLink, City of Vancouver, Parks Canada
 * …) and carry a per-camera credit, which is kept, HTML stripped, and shown with the frame.
 */
export const DRIVEBC_WEBCAMS_URL = 'https://www.drivebc.ca/api/webcams/';
export const DRIVEBC_FRAME_ORIGIN = 'https://www.drivebc.ca/images/';

export const drivebcPack: CatalogPack = {
  id: 'drivebc',
  registryId: 'drivebc',
  request: { url: DRIVEBC_WEBCAMS_URL, headers: { Accept: 'application/json' }, maxBytes: 8 * 1024 * 1024 },
  frameHosts: ['www.drivebc.ca'],
  attribution: 'DriveBC. Contains information licensed under the Open Government Licence – British Columbia',
  refreshSeconds: 300,
  normalize: normalizeDrivebc,
};

interface DrivebcRow {
  id?: unknown;
  name?: unknown;
  is_on?: unknown;
  should_appear?: unknown;
  region_name?: unknown;
  orientation?: unknown;
  elevation?: unknown;
  location?: { type?: unknown; coordinates?: unknown } | null;
  credit?: unknown;
}

export function normalizeDrivebc(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  if (!Array.isArray(payload))
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not an array of cameras' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<number>();
  payload.forEach((raw: unknown, index: number) => {
    const row = raw as DrivebcRow;
    if (!row || typeof row !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    if (row.is_on !== true || row.should_appear !== true) return; // switched off or unpublished upstream
    const id = row.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      rejected.push({ index, reason: 'invalid id' });
      return;
    }
    const coords = Array.isArray(row.location?.coordinates) ? (row.location.coordinates as unknown[]) : undefined;
    const lon = coords?.[0];
    const lat = coords?.[1];
    if (!isValidLatLon(lat, lon) || !isLikelyBc(lat, lon as number)) {
      rejected.push({ index, reason: 'invalid coordinates' });
      return;
    }
    if (seen.has(id)) {
      rejected.push({ index, reason: `duplicate id ${id}` });
      return;
    }
    seen.add(id);
    const orientation = typeof row.orientation === 'string' ? row.orientation.trim().toUpperCase().slice(0, 4) : '';
    const heading = /^(N|NE|E|SE|S|SW|W|NW)$/.test(orientation) ? directionToHeading(orientation) : undefined;
    const elevation =
      typeof row.elevation === 'number' && Number.isFinite(row.elevation)
        ? Math.max(-100, Math.min(4000, row.elevation))
        : undefined;
    const region = typeof row.region_name === 'string' ? row.region_name.trim().slice(0, 60) : '';
    const name =
      typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 120) : `DriveBC camera ${id}`;
    const credit = partnerCredit(row.credit);
    drafts.push(
      draftFromCamera(
        drivebcPack,
        {
          pack: 'drivebc',
          cameraId: String(id),
          name,
          latitude: lat,
          longitude: lon as number,
          ...(elevation !== undefined ? { altitudeM: elevation } : {}),
          region: region === 'Border Cams' ? 'BC border crossings' : region || 'British Columbia',
          ...(heading !== undefined ? { headingDegrees: heading, direction: orientation } : {}),
          frameUrl: `${DRIVEBC_FRAME_ORIGIN}${id}.jpg`,
          ...(credit ? { extra: { credit } } : {}),
        },
        opts,
        raw as JsonValue,
      ),
    );
  });
  return { drafts, total: payload.length, rejected };
}

/**
 * The owner credit a partner-supplied camera carries ("Images courtesy of TransLink"),
 * HTML stripped; anything else in the field is dropped.
 */
export function partnerCredit(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return /courtesy|provided by|presented in cooperation|city of|parks canada/i.test(text) ? text : '';
}

function isLikelyBc(lat: number, lon: number): boolean {
  return lat >= 48 && lat <= 60.5 && lon >= -139.5 && lon <= -114;
}
