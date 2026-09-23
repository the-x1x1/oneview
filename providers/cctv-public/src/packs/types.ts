import { stableStringify, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft, ProviderHttpRequest } from '@worldview/provider-sdk';

/**
 * A catalog pack turns one public camera catalog into observation drafts.
 * Packs are internal modules of the `public-cameras` provider; each one carries its
 * own licence record id, attribution and frame-host pin.
 */
export interface CatalogPack {
  /** Short pack id used in externalIds and media refs (`public:<pack>:<cameraId>`). */
  id: string;
  /** Record id in config/licenses/providers.json. */
  registryId: string;
  /**
   * Catalog request the provider issues through ProviderContext.http. A request that names
   * a `credential` runs only once that key is stored (the key is the operator's, declared
   * optional in the manifest); until then the pack is skipped, not failed.
   */
  request: CatalogRequest;
  /**
   * More catalogue parts (Caltrans publishes one file per district). When present the
   * provider fetches `request` and each of these, in order, and hands `normalize` the
   * array of payloads; a part that fails is logged and skipped as long as one succeeds.
   */
  moreRequests?: ReadonlyArray<CatalogRequest>;
  /** `text` for a catalogue that is not JSON (Hong Kong's is XML); default `json`. */
  format?: 'json' | 'text';
  /** What observations cite as their source, when the request URL should not be (it carries a key). */
  sourceRef?: string;
  /**
   * Where frames may live; the normalizer refuses everything else. An entry is a host
   * (`www.drivebc.ca`) or a host and path prefix (`s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/`)
   * for a pack whose frames sit on a shared host, where the host alone would admit anyone's files.
   */
  frameHosts: readonly string[];
  attribution: string;
  /** How often a frame changes upstream (seconds); the renderer polls at most this often. */
  refreshSeconds: number;
  normalize(payload: unknown, opts: PackNormalizeOptions): PackNormalizeResult;
}

export type CatalogRequest = Pick<
  ProviderHttpRequest,
  'url' | 'headers' | 'maxBytes' | 'timeoutMs' | 'method' | 'body' | 'credential'
>;

export interface PackNormalizeOptions {
  /** observedAt for every camera (catalog fetch time, adjusted for cache age). */
  observedAt: string;
  origin: 'live' | 'cached';
  sourceRef: string;
  hash: (input: string) => string;
}

export interface PackNormalizeResult {
  drafts: ObservationDraft[];
  /** Rows seen in the catalog (before rejection). */
  total: number;
  rejected: Array<{ index: number; reason: string }>;
  /** True when the payload did not have the expected top-level shape. */
  malformed?: boolean;
}

export interface PackCameraDraft {
  pack: string;
  cameraId: string;
  name: string;
  latitude: number;
  longitude: number;
  altitudeM?: number;
  region?: string;
  headingDegrees?: number;
  /** Source's textual facing when it publishes one (e.g. "NE"). */
  direction?: string;
  frameUrl: string;
  extra?: Record<string, JsonValue>;
}

export const CAMERA_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A rejection reason that shows the id it refused, so `rejected camera rows` in app.log says
 * what the catalogue sent rather than only that it was wrong. Printable ASCII, 24 characters
 * at most: catalogue ids are public data, but a malformed one can be anything.
 */
export function invalidIdReason(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const shown = text.replace(/[^\x20-\x7e]/g, '?').slice(0, 24);
  return `invalid id "${shown}"${text.length > 24 ? '…' : ''}`;
}

/**
 * The rejection reason for a frame URL off the pack's pinned hosts, naming where it pointed:
 * scheme (when not https), host and first path segment — never the rest of the path or the
 * query, which could carry anything. So `rejected camera rows` says which host a catalogue
 * moved to.
 */
export function offHostReason(url: string): string {
  let where: string;
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/');
    const first = segments[1] ? `/${segments[1]}${segments.length > 2 ? '/' : ''}` : '';
    where = `${u.protocol === 'https:' ? '' : u.protocol + '//'}${u.hostname}${first}`;
  } catch {
    where = url.trim() ? 'not a url' : 'no url';
  }
  return `frame url not on the pinned host (${where.replace(/[^\x20-\x7e]/g, '?').slice(0, 60)})`;
}

export function isOnHost(url: string, hosts: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !u.username && !u.password && hosts.some((h) => matchesFrameHost(u, h));
}

/** `entry` is a host, or a host and a path prefix ending in `/`; the URL is already parsed (dot segments resolved). */
export function matchesFrameHost(u: URL, entry: string): boolean {
  const slash = entry.indexOf('/');
  if (slash < 0) return u.hostname.toLowerCase() === entry.toLowerCase();
  const prefix = entry.slice(slash);
  return (
    u.hostname.toLowerCase() === entry.slice(0, slash).toLowerCase() &&
    u.pathname.startsWith(prefix) &&
    !/%2f/i.test(u.pathname.slice(prefix.length))
  );
}

/** Build the observation draft shared by every pack (payload conventions for `camera`). */
export function draftFromCamera(
  pack: CatalogPack,
  cam: PackCameraDraft,
  opts: PackNormalizeOptions,
  raw: JsonValue,
): ObservationDraft {
  const ref = `public:${pack.id}:${cam.cameraId}`;
  const payload: Record<string, JsonValue> = {
    name: cam.name,
    pack: pack.id,
    frameUrl: cam.frameUrl,
    refreshSeconds: pack.refreshSeconds,
    attribution: pack.attribution,
    media: [{ kind: 'snapshot', ref, mimeType: 'image/jpeg' }],
    ...(cam.extra ?? {}),
  };
  if (cam.region) payload['region'] = cam.region;
  if (cam.headingDegrees !== undefined) payload['headingDegrees'] = cam.headingDegrees;
  if (cam.direction) payload['direction'] = cam.direction;
  const draft: ObservationDraft = {
    externalId: `${pack.id}:${cam.cameraId}`,
    objectType: 'camera',
    observedAt: opts.observedAt,
    position: {
      latitude: cam.latitude,
      longitude: cam.longitude,
      ...(cam.altitudeM !== undefined ? { altitudeM: cam.altitudeM, altitudeDatum: 'msl' as const } : {}),
    },
    payload,
    quality: {
      complete: true,
      sourceQuality: 'authoritative',
      ...(cam.headingDegrees === undefined ? { flags: ['heading-unknown'] } : {}),
    },
    origin: opts.origin,
    sourceRef: opts.sourceRef,
    rawPayloadHash: opts.hash(stableStringify(raw)),
  };
  return draft;
}
