/**
 * Coordinate reference system names as OGC services write them, reduced to what the OGC
 * connectors need to decide: is this WGS 84 in longitude/latitude (CRS84), WGS 84 as
 * EPSG:4326, Web Mercator, or something else — and, for EPSG:4326, which axis comes
 * first according to the way it is written.
 *
 * The spellings are many: `EPSG:4326`, `urn:ogc:def:crs:EPSG::4326`,
 * `urn:ogc:def:crs:EPSG:6.18.3:3857`, `urn:x-ogc:def:crs:EPSG:4326`,
 * `http://www.opengis.net/def/crs/EPSG/0/4326`, `http://www.opengis.net/gml/srs/epsg.xml#4326`,
 * and for CRS84 `CRS:84`, `urn:ogc:def:crs:OGC:1.3:CRS84`, `urn:ogc:def:crs:OGC:2:84`,
 * `urn:ogc:def:crs:CRS::84` (GeoServer's GeoJSON), `http://www.opengis.net/def/crs/OGC/1.3/CRS84`.
 */
export type CrsKind = 'crs84' | 'epsg4326' | 'webmercator' | 'other';

export interface CrsInfo {
  kind: CrsKind;
  /** `EPSG:<code>` when the name carries an EPSG code. */
  epsg?: string;
  /**
   * Whether the name, read by the book, puts latitude first: the URN and URI forms of
   * EPSG:4326 do; the legacy `EPSG:4326` and `…epsg.xml#4326` forms and every CRS84 form do
   * not. What a server actually sends can differ (see wfs.ts).
   */
  latFirst: boolean;
}

const CRS84 = [
  /^crs:84$/,
  /^urn:ogc:def:crs:ogc:[\d.]*:crs84$/,
  /^urn:ogc:def:crs:ogc:2:84$/,
  /^urn:ogc:def:crs:crs:[\d.]*:84$/,
  /^https?:\/\/www\.opengis\.net\/def\/crs\/ogc\/[\d.]+\/crs84$/,
  /^ogc:crs84$/,
];

const WEB_MERCATOR = new Set(['3857', '900913', '102100', '102113', '3785']);

export function epsgCode(crs: string): string | undefined {
  const s = crs.trim().toLowerCase();
  const m =
    /^epsg:(\d+)$/.exec(s) ??
    /^urn:(?:x-)?ogc:def:crs:epsg:(?:[\d.]*:)?(\d+)$/.exec(s) ??
    /^https?:\/\/www\.opengis\.net\/def\/crs\/epsg\/[\d.]+\/(\d+)$/.exec(s) ??
    /^https?:\/\/www\.opengis\.net\/gml\/srs\/epsg\.xml#(\d+)$/.exec(s);
  return m?.[1];
}

export function classifyCrs(crs: string): CrsInfo {
  const s = crs.trim().toLowerCase();
  if (CRS84.some((re) => re.test(s))) return { kind: 'crs84', latFirst: false };
  const code = epsgCode(s);
  if (!code) return { kind: 'other', latFirst: false };
  const epsg = `EPSG:${code}`;
  if (code === '4326') {
    const legacy = /^epsg:4326$/.test(s) || s.includes('epsg.xml#');
    return { kind: 'epsg4326', epsg, latFirst: !legacy };
  }
  if (WEB_MERCATOR.has(code)) return { kind: 'webmercator', epsg, latFirst: false };
  return { kind: 'other', epsg, latFirst: false };
}

export const isCrs84 = (crs: string): boolean => classifyCrs(crs).kind === 'crs84';
export const isWgs84 = (crs: string): boolean => {
  const k = classifyCrs(crs).kind;
  return k === 'crs84' || k === 'epsg4326';
};
export const isWebMercator = (crs: string): boolean => classifyCrs(crs).kind === 'webmercator';

/** The two names the WFS connector asks for. */
export const CRS84_URN = 'urn:ogc:def:crs:OGC:1.3:CRS84';
export const EPSG4326_URN = 'urn:ogc:def:crs:EPSG::4326';
