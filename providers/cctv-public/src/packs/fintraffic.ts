import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import { normalizeHeading } from '../direction.js';
import { draftFromCamera, type CatalogPack, type PackNormalizeOptions, type PackNormalizeResult } from './types.js';

/**
 * Fintraffic / Digitraffic road weather cameras (Finland), CC BY 4.0.
 * Adapted from gods-eye-view server/providers/cctv/sources.js (MIT), loadFintrafficSourcesFromOpenData.
 *
 * One GeoJSON station list covers the country; each STATION carries N presets
 * (fixed views) sharing the station position. One preset = one camera. Stations
 * whose `collectionStatus` is not GATHERING and presets with `inCollection: false`
 * are skipped. Frame URLs are BUILT from the official image origin and a strictly
 * validated preset id — never read from the payload — so the frame host is pinned
 * by construction. Digitraffic asks clients to identify with a `Digitraffic-User`
 * header and to respect the 600 s image refresh.
 *
 * Heading: the station list publishes no compass bearing. A numeric `direction`
 * on a preset (0–360) is taken as degrees when present; the textual road-register
 * codes the detail endpoint uses (INCREASING_DIRECTION …) are not bearings and are
 * ignored, so most presets carry the `heading-unknown` flag.
 */
export const FINTRAFFIC_STATIONS_URL = 'https://tie.digitraffic.fi/api/weathercam/v1/stations';
export const FINTRAFFIC_FRAME_ORIGIN = 'https://weathercam.digitraffic.fi/';
export const DIGITRAFFIC_USER = 'worldview';

const PRESET_ID = /^C\d{7}$/;
const STATION_ID = /^C\d{5}$/;

export const fintrafficPack: CatalogPack = {
  id: 'fintraffic',
  registryId: 'fintraffic-weathercams',
  request: { url: FINTRAFFIC_STATIONS_URL, headers: { Accept: 'application/geo+json, application/json', 'Digitraffic-User': DIGITRAFFIC_USER }, maxBytes: 6 * 1024 * 1024 },
  frameHosts: ['weathercam.digitraffic.fi'],
  attribution: 'Fintraffic / digitraffic.fi, license CC BY 4.0',
  refreshSeconds: 600,
  normalize: normalizeFintraffic,
};

interface StationFeature {
  type?: unknown;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: { id?: unknown; name?: unknown; collectionStatus?: unknown; presets?: unknown; municipality?: unknown; province?: unknown } | null;
}

export function normalizeFintraffic(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult {
  if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'FeatureCollection') {
    return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'not a FeatureCollection' }], malformed: true };
  }
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features)) return { drafts: [], total: 0, rejected: [{ index: -1, reason: 'features is not an array' }], malformed: true };
  const drafts: ObservationDraft[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  let total = 0;
  features.forEach((raw: unknown, index: number) => {
    const f = raw as StationFeature;
    const p = f?.properties;
    if (!p || typeof p !== 'object') { total++; rejected.push({ index, reason: 'missing properties' }); return; }
    const stationId = typeof p.id === 'string' ? p.id.trim() : '';
    if (!STATION_ID.test(stationId)) { total++; rejected.push({ index, reason: 'invalid station id' }); return; }
    if (String(p.collectionStatus ?? '').toUpperCase() !== 'GATHERING') return; // not an error: station is not collecting
    const coords = f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates) ? (f.geometry.coordinates as unknown[]) : undefined;
    const lon = coords?.[0];
    const lat = coords?.[1];
    if (!isValidLatLon(lat, lon) || !isLikelyFinland(lat, lon as number)) { total++; rejected.push({ index, reason: 'invalid coordinates' }); return; }
    const alt = typeof coords?.[2] === 'number' && Number.isFinite(coords[2]) && coords[2] > 0 ? Math.min(1400, coords[2]) : undefined;
    const name = stationName(p.name, stationId);
    const region = typeof p.municipality === 'string' && p.municipality.trim() ? p.municipality.trim().slice(0, 80) : typeof p.province === 'string' && p.province.trim() ? p.province.trim().slice(0, 80) : undefined;
    const presets = Array.isArray(p.presets) ? (p.presets as unknown[]) : [];
    for (const rawPreset of presets) {
      const preset = rawPreset as { id?: unknown; inCollection?: unknown; presentationName?: unknown; direction?: unknown } | null;
      if (!preset || typeof preset !== 'object' || preset.inCollection !== true) continue;
      total++;
      const presetId = typeof preset.id === 'string' ? preset.id.trim() : '';
      if (!PRESET_ID.test(presetId) || !presetId.startsWith(stationId)) { rejected.push({ index, reason: `invalid preset id for ${stationId}` }); continue; }
      if (seen.has(presetId)) { rejected.push({ index, reason: `duplicate preset ${presetId}` }); continue; }
      seen.add(presetId);
      const view = presetId.slice(stationId.length);
      const presentation = typeof preset.presentationName === 'string' && preset.presentationName.trim() ? preset.presentationName.trim().slice(0, 80) : undefined;
      const heading = normalizeHeading(preset.direction);
      drafts.push(draftFromCamera(fintrafficPack, {
        pack: 'fintraffic',
        cameraId: presetId,
        name: presentation ? `${name} — ${presentation}` : `${name} (view ${view})`,
        latitude: lat,
        longitude: lon as number,
        ...(alt !== undefined ? { altitudeM: alt } : {}),
        ...(region ? { region } : {}),
        ...(heading !== undefined ? { headingDegrees: heading } : {}),
        frameUrl: `${FINTRAFFIC_FRAME_ORIGIN}${presetId}.jpg`,
        extra: { stationId, presetId, ...(presentation ? { view: presentation } : {}) },
      }, opts, { station: stationId, preset: rawPreset as JsonValue }));
    }
  });
  return { drafts, total, rejected };
}

function stationName(raw: unknown, stationId: string): string {
  const base = typeof raw === 'string' ? raw.replace(/_/g, ' ').trim().slice(0, 120) : '';
  return base || `Fintraffic ${stationId}`;
}

function isLikelyFinland(lat: number, lon: number): boolean {
  return lat >= 59.5 && lat <= 70.5 && lon >= 19 && lon <= 32;
}
