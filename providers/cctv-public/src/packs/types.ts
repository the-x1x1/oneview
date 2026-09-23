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
  /** Catalog request the provider issues through ProviderContext.http. */
  request: Pick<ProviderHttpRequest, 'url' | 'headers' | 'maxBytes' | 'timeoutMs'>;
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
