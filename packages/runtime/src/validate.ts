import {
  SEVERITY_ORDER,
  isValidLatLon,
  type GeoPosition,
  type GeoRegion,
  type SeverityClass,
} from '@worldview/world-model';
import type { Collection, CollectionItem, WatchZone } from '@worldview/ipc-contract';
import type { LensDefinition } from '@worldview/render-core';

/**
 * Trust-boundary validation for user documents and IPC requests. Everything that comes
 * from the renderer or from a file on disk is parsed into the contract shape here; an
 * invalid entry is dropped rather than stored, and an invalid request throws so the IPC
 * layer maps it to INVALID_REQUEST.
 */
export class InvalidRequestError extends Error {
  readonly ipcCode = 'INVALID_REQUEST' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

export class NotFoundError extends Error {
  readonly ipcCode = 'NOT_FOUND' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class DeniedError extends Error {
  readonly ipcCode = 'DENIED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DeniedError';
  }
}

export class UnavailableError extends Error {
  readonly ipcCode = 'UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'UnavailableError';
  }
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function id(value: unknown, max = 128): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
}

function iso(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function position(value: unknown): GeoPosition | undefined {
  const r = rec(value);
  if (!r) return undefined;
  const lat = r['latitude'],
    lon = r['longitude'];
  if (typeof lat !== 'number' || typeof lon !== 'number' || !isValidLatLon(lat, lon)) return undefined;
  const out: GeoPosition = { latitude: lat, longitude: lon };
  if (typeof r['altitudeM'] === 'number' && Number.isFinite(r['altitudeM'])) out.altitudeM = r['altitudeM'];
  return out;
}

function stringList(value: unknown, max = 64): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, max);
}

function bounds(value: unknown): { west: number; south: number; east: number; north: number } | undefined {
  const b = rec(value);
  if (!b) return undefined;
  const [w, s, e, n] = [b['west'], b['south'], b['east'], b['north']];
  if ([w, s, e, n].some((v) => typeof v !== 'number' || !Number.isFinite(v))) return undefined;
  return { west: w as number, south: s as number, east: e as number, north: n as number };
}

export function validateRegion(value: unknown): GeoRegion | undefined {
  const r = rec(value);
  if (!r) return undefined;
  switch (r['kind']) {
    case 'bounds': {
      const b = bounds(r['bounds']);
      return b ? { kind: 'bounds', bounds: b } : undefined;
    }
    case 'circle': {
      const centre = position(r['center']);
      const radius = r['radiusM'];
      if (!centre || typeof radius !== 'number' || !(radius > 0) || !Number.isFinite(radius)) return undefined;
      return { kind: 'circle', center: centre, radiusM: radius };
    }
    case 'polygon': {
      const raw = r['polygon'];
      if (!Array.isArray(raw) || raw.length < 3) return undefined;
      const polygon: Array<[number, number]> = [];
      for (const point of raw) {
        if (!Array.isArray(point) || point.length < 2) return undefined;
        const [lon, lat] = point as unknown[];
        if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat))
          return undefined;
        polygon.push([lon, lat]);
      }
      return { kind: 'polygon', polygon };
    }
    case 'admin': {
      const regionId = id(r['regionId']);
      if (!regionId) return undefined;
      const b = bounds(r['bounds']);
      return b ? { kind: 'admin', regionId, bounds: b } : { kind: 'admin', regionId };
    }
    default:
      return undefined;
  }
}

function severity(value: unknown): SeverityClass | undefined {
  return typeof value === 'string' && value in SEVERITY_ORDER ? (value as SeverityClass) : undefined;
}

const ITEM_KINDS = new Set(['location', 'object', 'event', 'watchzone', 'note', 'lens']);

function validateCollectionItem(value: unknown): CollectionItem | undefined {
  const r = rec(value);
  if (!r) return undefined;
  const itemId = id(r['id']);
  const kind =
    typeof r['kind'] === 'string' && ITEM_KINDS.has(r['kind']) ? (r['kind'] as CollectionItem['kind']) : undefined;
  const title = typeof r['title'] === 'string' ? r['title'].slice(0, 200) : undefined;
  const createdAt = iso(r['createdAt']);
  const updatedAt = iso(r['updatedAt']);
  if (!itemId || !kind || title === undefined || !createdAt || !updatedAt) return undefined;
  const item: CollectionItem = { id: itemId, kind, title, createdAt, updatedAt };
  const p = position(r['position']);
  if (p) item.position = p;
  for (const key of ['objectId', 'eventId', 'watchZoneId', 'lensId'] as const) {
    const v = id(r[key], 256);
    if (v) item[key] = v;
  }
  if (typeof r['note'] === 'string') item.note = r['note'].slice(0, 4000);
  const tags = stringList(r['tags'], 32);
  if (tags) item.tags = tags;
  return item;
}

export function validateCollection(value: unknown): Collection | undefined {
  const r = rec(value);
  if (!r) return undefined;
  const collectionId = id(r['id']);
  const name = typeof r['name'] === 'string' ? r['name'].slice(0, 200) : undefined;
  const createdAt = iso(r['createdAt']);
  const updatedAt = iso(r['updatedAt']);
  if (!collectionId || !name || !createdAt || !updatedAt) return undefined;
  const items = Array.isArray(r['items'])
    ? r['items']
        .map(validateCollectionItem)
        .filter((i): i is CollectionItem => i !== undefined)
        .slice(0, 2000)
    : [];
  return { id: collectionId, name, createdAt, updatedAt, items };
}

export function validateWatchZone(value: unknown): WatchZone | undefined {
  const r = rec(value);
  if (!r) return undefined;
  const zoneId = id(r['id']);
  const name = typeof r['name'] === 'string' ? r['name'].slice(0, 200) : undefined;
  const geometry = validateRegion(r['geometry']);
  const eventTypes = stringList(r['eventTypes'], 32);
  const createdAt = iso(r['createdAt']);
  const notifications = rec(r['notifications']);
  if (!zoneId || !name || !geometry || !eventTypes || !createdAt || !notifications) return undefined;
  const zone: WatchZone = {
    id: zoneId,
    name,
    geometry,
    eventTypes,
    notifications: { inApp: notifications['inApp'] === true, desktop: notifications['desktop'] === true },
    enabled: r['enabled'] !== false,
    createdAt,
  };
  const min = severity(r['minimumSeverity']);
  if (min) zone.minimumSeverity = min;
  return zone;
}

export function validateLens(value: unknown): LensDefinition | undefined {
  const r = rec(value);
  if (!r) return undefined;
  const lensId = id(r['id']);
  const name = typeof r['name'] === 'string' ? r['name'].slice(0, 200) : undefined;
  const objectTypes = stringList(r['objectTypes'], 64);
  const eventTypes = stringList(r['eventTypes'], 64);
  const visiblePanels = stringList(r['visiblePanels'], 32);
  if (!lensId || !name || !objectTypes || !eventTypes || !visiblePanels) return undefined;
  const lens: LensDefinition = {
    id: lensId,
    name,
    objectTypes,
    eventTypes,
    visiblePanels,
    renderingRules: Array.isArray(r['renderingRules'])
      ? (r['renderingRules'] as LensDefinition['renderingRules']).slice(0, 64)
      : [],
  };
  if (typeof r['description'] === 'string') lens.description = r['description'].slice(0, 500);
  const prefs = stringList(r['providerPreferences'], 32);
  if (prefs) lens.providerPreferences = prefs;
  if (r['builtIn'] === true) lens.builtIn = true;
  return lens;
}

/** Throwing variants for IPC requests (the shell must not be able to store junk). */
export function requireCollection(value: unknown): Collection {
  const c = validateCollection(value);
  if (!c) throw new InvalidRequestError('invalid collection');
  return c;
}

export function requireWatchZone(value: unknown): WatchZone {
  const z = validateWatchZone(value);
  if (!z) throw new InvalidRequestError('invalid watch zone');
  return z;
}

export function requireLens(value: unknown): LensDefinition {
  const l = validateLens(value);
  if (!l) throw new InvalidRequestError('invalid lens');
  return l;
}

/**
 * A camera the gateway registered, as stored in `cameras.json`. The URL is kept — the
 * gateway cannot fetch a frame without it — but any credential it carried was moved to
 * the OS credential store at registration and only its key is here, so this file never
 * contains a secret. Validation is the same trust boundary as every other user
 * document: a hostile or corrupt entry is dropped, not loaded.
 */
export function validateStoredCamera(value: unknown): StoredCamera | undefined {
  const r = rec(value);
  if (!r) return undefined;
  const cameraId = typeof r['cameraId'] === 'string' ? r['cameraId'] : typeof r['id'] === 'string' ? r['id'] : '';
  if (!/^[0-9a-f]{12}$/.test(cameraId)) return undefined;
  const name = typeof r['name'] === 'string' ? r['name'].trim().slice(0, 120) : '';
  const url = typeof r['url'] === 'string' ? r['url'] : '';
  const kind = typeof r['kind'] === 'string' ? r['kind'] : '';
  const objectId = typeof r['objectId'] === 'string' ? r['objectId'] : '';
  const registeredAt = iso(r['registeredAt']);
  if (!name || !url || !objectId || !registeredAt) return undefined;
  if (!CAMERA_KINDS.includes(kind as StoredCamera['kind'])) return undefined;
  // A URL is what the gateway will fetch, so the scheme is constrained here as well as
  // in the gateway: anything else (file:, data:, javascript:) never reaches it.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:', 'rtsp:', 'rtsps:'].includes(parsed.protocol)) return undefined;
  if (parsed.username || parsed.password) return undefined; // credentials belong in the credential store
  const camera: StoredCamera = {
    id: cameraId,
    cameraId,
    objectId,
    name,
    url,
    kind: kind as StoredCamera['kind'],
    registeredAt,
  };
  const credentialKey = r['credentialKey'];
  if (typeof credentialKey === 'string' && /^camera\.[0-9a-f]{12}\.credential$/.test(credentialKey))
    camera.credentialKey = credentialKey;
  const pos = rec(r['position']);
  if (pos && isValidLatLon(pos['latitude'], pos['longitude']))
    camera.position = { latitude: pos['latitude'] as number, longitude: pos['longitude'] as number };
  const heading = r['headingDegrees'];
  if (typeof heading === 'number' && Number.isFinite(heading)) camera.headingDegrees = ((heading % 360) + 360) % 360;
  return camera;
}

const CAMERA_KINDS = ['mjpeg', 'hls', 'snapshot', 'rtsp'] as const;

/** `RegisteredCamera` plus the `id` the document store keys on (always the camera id). */
export interface StoredCamera {
  id: string;
  cameraId: string;
  objectId: string;
  name: string;
  url: string;
  kind: (typeof CAMERA_KINDS)[number];
  credentialKey?: string;
  position?: GeoPosition;
  headingDegrees?: number;
  registeredAt: string;
}
