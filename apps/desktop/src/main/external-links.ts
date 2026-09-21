import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * `app.openExternal` allowlist: the renderer may only ask main to open https URLs
 * whose host is known — attribution/terms links from provider manifests plus a
 * small static set (project pages, key sign-up pages). Everything else is refused
 * with DENIED and logged; nothing is ever opened with a scheme other than https.
 */
export const STATIC_EXTERNAL_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'earthquake.usgs.gov',
  'www.usgs.gov',
  'celestrak.org',
  'firms.modaps.eosdis.nasa.gov',
  'www.earthdata.nasa.gov',
  'aisstream.io',
  'opensky-network.org',
  'adsb.lol',
  'api.weather.gov',
  'www.weather.gov',
  'open-meteo.com',
  'www.openstreetmap.org',
  'www.naturalearthdata.com',
  'maplibre.org',
  'cesium.com',
  'developer.tomtom.com',
]);

export type ExternalHostAllowlist = ReadonlySet<string>;

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : undefined;
  } catch { return undefined; }
}

/** Hosts derived from manifests: dataPolicy.termsUrl, attribution.url and credential helpUrls. */
export function buildExternalHostAllowlist(manifests: Iterable<Pick<ProviderManifest, 'dataPolicy' | 'attribution' | 'credentials'>>, extra: Iterable<string> = STATIC_EXTERNAL_HOSTS): ExternalHostAllowlist {
  const hosts = new Set<string>();
  for (const h of extra) hosts.add(h.toLowerCase());
  for (const m of manifests) {
    for (const url of [m.dataPolicy.termsUrl, m.attribution.url, ...m.credentials.map((c) => c.helpUrl)]) {
      const h = hostOf(url);
      if (h) hosts.add(h);
    }
  }
  return hosts;
}

export interface ExternalUrlVerdict { allowed: boolean; reason?: string; host?: string }

export function checkExternalUrl(url: string, allow: ExternalHostAllowlist): ExternalUrlVerdict {
  if (typeof url !== 'string' || url.length > 2048) return { allowed: false, reason: 'url too long' };
  let u: URL;
  try { u = new URL(url); } catch { return { allowed: false, reason: 'invalid url' }; }
  if (u.protocol !== 'https:') return { allowed: false, reason: `scheme ${u.protocol} not allowed (https only)` };
  if (u.username || u.password) return { allowed: false, reason: 'credentials in url' };
  const host = u.hostname.toLowerCase();
  if (host === '' || /^[\d.]+$/.test(host) || host.includes(':')) return { allowed: false, reason: 'ip literals are not allowed', host };
  for (const h of allow) if (host === h || host.endsWith(`.${h}`)) return { allowed: true, host };
  return { allowed: false, reason: `host ${host} is not in the external link allowlist`, host };
}
