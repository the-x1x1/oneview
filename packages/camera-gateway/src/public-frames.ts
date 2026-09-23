import type { JsonValue, WorldObject } from '@worldview/world-model';
import { silentLogger, type Logger } from '@worldview/core';

/**
 * PublicFrameRegistry — the allowlist of public-camera frame URLs the gateway may fetch.
 *
 * Providers cannot import this package (they depend on world-model + provider-sdk
 * only), so the flow is: the `public-cameras` provider emits camera observations whose
 * payload carries `pack`, `frameUrl` and a media ref `public:<pack>:<cameraId>`; the
 * runtime feeds the resulting world-state camera objects into `syncFromObjects()`;
 * only refs present here are ever resolved to a fetch. Each entry is re-validated
 * against a static per-pack frame-host allowlist — the provider validates too, but the
 * gateway does not trust world state blindly (defence in depth).
 */
export const PUBLIC_FRAME_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  fintraffic: Object.freeze(['weathercam.digitraffic.fi']),
  nsw: Object.freeze(['webcams.transport.nsw.gov.au']),
  // A host and a path prefix: TfL's frames sit in one bucket on a shared S3 host.
  tfl: Object.freeze(['s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/']),
  ontario: Object.freeze(['511on.ca']),
  drivebc: Object.freeze(['www.drivebc.ca']),
  calgary: Object.freeze(['trafficcam.calgary.ca']),
});

export const PUBLIC_MEDIA_REF = /^public:([a-z0-9-]+):([A-Za-z0-9._-]{1,64})$/;

export interface PublicCamera {
  /** Media ref, e.g. `public:fintraffic:C0150201`. */
  ref: string;
  pack: string;
  cameraId: string;
  objectId: string;
  frameUrl: string;
  refreshSeconds: number;
  attribution: string;
  name?: string;
}

export interface PublicFrameRegistryOptions {
  hosts?: Readonly<Record<string, readonly string[]>>;
  logger?: Logger;
}

export class PublicFrameRegistry {
  private readonly byRef = new Map<string, PublicCamera>();
  private readonly byObject = new Map<string, string>();
  private readonly hosts: Readonly<Record<string, readonly string[]>>;
  private readonly logger: Logger;

  constructor(opts: PublicFrameRegistryOptions = {}) {
    this.hosts = opts.hosts ?? PUBLIC_FRAME_HOSTS;
    this.logger = opts.logger ?? silentLogger;
  }

  size(): number {
    return this.byRef.size;
  }
  get(ref: string): PublicCamera | undefined {
    return this.byRef.get(ref);
  }
  refs(): string[] {
    return [...this.byRef.keys()];
  }

  /** Replace the registry with the cameras derivable from these objects. */
  syncFromObjects(objects: Iterable<WorldObject>): { accepted: number; rejected: number } {
    const next = new Map<string, PublicCamera>();
    let rejected = 0;
    for (const obj of objects) {
      const cam = publicCameraFromObject(obj, this.hosts);
      if (!cam) {
        if (obj.type === 'camera' && typeof obj.properties['pack'] === 'string') rejected++;
        continue;
      }
      next.set(cam.ref, cam);
    }
    this.byRef.clear();
    this.byObject.clear();
    for (const cam of next.values()) {
      this.byRef.set(cam.ref, cam);
      this.byObject.set(cam.objectId, cam.ref);
    }
    if (rejected) this.logger.warn('public cameras rejected by frame-host allowlist', { rejected });
    return { accepted: next.size, rejected };
  }

  /** Incremental update for world.changed events. Returns whether the object is now registered. */
  upsertFromObject(obj: WorldObject): boolean {
    const cam = publicCameraFromObject(obj, this.hosts);
    const previousRef = this.byObject.get(obj.id);
    if (previousRef && (!cam || cam.ref !== previousRef)) {
      this.byRef.delete(previousRef);
      this.byObject.delete(obj.id);
    }
    if (!cam) return false;
    this.byRef.set(cam.ref, cam);
    this.byObject.set(obj.id, cam.ref);
    return true;
  }

  removeObject(objectId: string): void {
    const ref = this.byObject.get(objectId);
    if (ref) {
      this.byRef.delete(ref);
      this.byObject.delete(objectId);
    }
  }
}

export function publicCameraFromObject(
  obj: WorldObject,
  hosts: Readonly<Record<string, readonly string[]>> = PUBLIC_FRAME_HOSTS,
): PublicCamera | undefined {
  if (obj.type !== 'camera') return undefined;
  const pack = obj.properties['pack'];
  const frameUrl = obj.properties['frameUrl'];
  if (typeof pack !== 'string' || typeof frameUrl !== 'string') return undefined;
  const allowed = hosts[pack];
  if (!allowed) return undefined;
  const media = obj.media ?? mediaFromProperties(obj.properties['media']);
  const ref = media
    .map((m) => m.ref)
    .find((r) => {
      const m = PUBLIC_MEDIA_REF.exec(r);
      return m !== null && m[1] === pack;
    });
  if (!ref) return undefined;
  const cameraId = PUBLIC_MEDIA_REF.exec(ref)![2]!;
  if (!isAllowedFrameUrl(frameUrl, allowed)) return undefined;
  const refresh = obj.properties['refreshSeconds'];
  const attribution =
    typeof obj.properties['attribution'] === 'string'
      ? obj.properties['attribution']
      : (obj.provenance.attribution ?? '');
  const cam: PublicCamera = {
    ref,
    pack,
    cameraId,
    objectId: obj.id,
    frameUrl,
    refreshSeconds: typeof refresh === 'number' && refresh >= 10 ? refresh : 60,
    attribution,
  };
  if (typeof obj.labels['name'] === 'string') cam.name = obj.labels['name'];
  return cam;
}

export function isAllowedFrameUrl(url: string, allowedHosts: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return allowedHosts.some((entry) => {
    // An entry is a host, or a host and a path prefix ending in "/" (a shared host).
    const slash = entry.indexOf('/');
    if (slash < 0) return u.hostname.toLowerCase() === entry.toLowerCase();
    const prefix = entry.slice(slash);
    return (
      u.hostname.toLowerCase() === entry.slice(0, slash).toLowerCase() &&
      u.pathname.startsWith(prefix) &&
      !/%2f/i.test(u.pathname.slice(prefix.length))
    );
  });
}

function mediaFromProperties(value: JsonValue | undefined): Array<{ kind: string; ref: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ kind: string; ref: string }> = [];
  for (const item of value) {
    if (
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof item['kind'] === 'string' &&
      typeof item['ref'] === 'string'
    )
      out.push({ kind: item['kind'], ref: item['ref'] });
  }
  return out;
}
