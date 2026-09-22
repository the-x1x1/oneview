/**
 * Deterministic identifiers. Identity is never a display name.
 *
 *   aircraft:icao24:a1b2c3
 *   vessel:mmsi:123456789
 *   satellite:norad:25544
 *   earthquake:usgs:us7000abcd
 *   airport:icao:PHNL
 *   camera:fintraffic:C0150201
 *   <type>:<namespace>:<value>
 *
 * Namespaces are authoritative id schemes (icao24, mmsi, norad, usgs, ...) or a provider id
 * for provider-scoped ids. Values are lower-cased for case-insensitive schemes.
 */
export interface ParsedObjectId {
  type: string;
  namespace: string;
  value: string;
}

const SAFE = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:+@-]*$/;

export const AuthoritativeNamespaces = Object.freeze(
  new Set(['icao24', 'mmsi', 'norad', 'usgs', 'imo', 'icao', 'iata', 'wmo', 'nws', 'firms']),
);

export function makeObjectId(type: string, namespace: string, value: string): string {
  if (!SAFE.test(type)) throw new Error(`invalid object type "${type}"`);
  if (!SAFE.test(namespace)) throw new Error(`invalid id namespace "${namespace}"`);
  const v = String(value).trim();
  if (!SAFE_VALUE.test(v)) throw new Error(`invalid id value "${value}" for ${type}:${namespace}`);
  return `${type}:${namespace}:${v}`;
}

export function parseObjectId(id: string): ParsedObjectId | undefined {
  const first = id.indexOf(':');
  if (first <= 0) return undefined;
  const second = id.indexOf(':', first + 1);
  if (second <= first + 1 || second === id.length - 1) return undefined;
  return { type: id.slice(0, first), namespace: id.slice(first + 1, second), value: id.slice(second + 1) };
}

export function isAuthoritativeId(id: string): boolean {
  const p = parseObjectId(id);
  return p !== undefined && AuthoritativeNamespaces.has(p.namespace);
}

export const Ids = {
  aircraftByIcao24: (hex: string) => makeObjectId('aircraft', 'icao24', hex.toLowerCase()),
  vesselByMmsi: (mmsi: string | number) => makeObjectId('vessel', 'mmsi', String(mmsi)),
  satelliteByNorad: (norad: string | number) => makeObjectId('satellite', 'norad', String(norad)),
  earthquakeByUsgs: (usgsId: string) => makeObjectId('earthquake', 'usgs', usgsId),
  airportByIcao: (icao: string) => makeObjectId('airport', 'icao', icao.toUpperCase()),
  cameraByProvider: (providerId: string, cameraId: string) => makeObjectId('camera', providerId, cameraId),
  providerScoped: (type: string, providerId: string, value: string) => makeObjectId(type, providerId, value),
} as const;
