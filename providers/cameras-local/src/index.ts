import { isValidLatLon, type GeoPosition, type JsonValue, type Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  buildObservation,
  type ObservationDraft,
  type ProviderContext,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import { CAMERAS_LOCAL_MANIFEST } from './manifest.js';

export { CAMERAS_LOCAL_MANIFEST } from './manifest.js';

/**
 * Settings shape, written by the runtime whenever the camera gateway's registry
 * changes (`camera.register` / `camera.unregister`). Contains no URL and no secret.
 */
export interface LocalCameraSetting {
  /** 12 hex chars, assigned by the gateway (sha256 of the normalized URL). */
  cameraId: string;
  name: string;
  position?: GeoPosition;
  headingDegrees?: number;
  gateway?: 'direct' | 'go2rtc';
  /** Source kind the gateway inferred (mjpeg | hls | snapshot | rtsp). */
  kind?: string;
}

export interface CamerasLocalSettings {
  cameras: LocalCameraSetting[];
}

const CAMERA_ID = /^[0-9a-f]{12}$/;

export class CamerasLocalProvider extends PollingProvider {
  readonly manifest: ProviderManifest = CAMERAS_LOCAL_MANIFEST;
  private settings: CamerasLocalSettings = { cameras: [] };
  private rejectedCount = 0;

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.apply(await context.settings.get());
    context.settings.onChange((s) => this.apply(s));
  }

  private apply(raw: Record<string, JsonValue>): void {
    const parsed = parseSettings(raw);
    this.settings = parsed.settings;
    this.rejectedCount = parsed.rejected;
    if (parsed.rejected && this.context)
      this.context.logger.warn('ignored invalid camera entries', { count: parsed.rejected });
  }

  cameras(): LocalCameraSetting[] {
    return this.settings.cameras;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled');
    const now = new Date(this.context.clock.now()).toISOString();
    const observations = this.settings.cameras.map((cam) => buildObservation(this.manifest, now, draftFor(cam, now)));
    return { observations, cacheAgeMs: 0 };
  }

  /** Number of settings entries dropped by validation (diagnostics). */
  invalidEntries(): number {
    return this.rejectedCount;
  }
}

export function draftFor(cam: LocalCameraSetting, observedAt: string): ObservationDraft {
  const ref = `camera:${cam.cameraId}`;
  const media: JsonValue[] = [{ kind: 'snapshot', ref }];
  if (cam.kind !== 'snapshot') media.push({ kind: 'stream', ref });
  const payload: Record<string, JsonValue> = { name: cam.name, gateway: cam.gateway ?? 'direct', media };
  if (cam.kind) payload['sourceKind'] = cam.kind;
  if (cam.headingDegrees !== undefined) payload['headingDegrees'] = cam.headingDegrees;
  const draft: ObservationDraft = {
    externalId: cam.cameraId,
    objectType: 'camera',
    observedAt,
    payload,
    quality: {
      complete: true,
      sourceQuality: 'authoritative',
      ...(cam.position ? {} : { flags: ['position-unknown'] }),
    },
    origin: 'local',
    sourceRef: `camera-gateway:${cam.gateway ?? 'direct'}`,
  };
  if (cam.position) draft.position = cam.position;
  return draft;
}

export function parseSettings(raw: Record<string, unknown>): { settings: CamerasLocalSettings; rejected: number } {
  const list = Array.isArray(raw['cameras']) ? (raw['cameras'] as unknown[]) : [];
  const cameras: LocalCameraSetting[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const item of list) {
    const cam = parseCamera(item);
    if (!cam || seen.has(cam.cameraId)) {
      rejected++;
      continue;
    }
    seen.add(cam.cameraId);
    cameras.push(cam);
  }
  return { settings: { cameras }, rejected };
}

function parseCamera(item: unknown): LocalCameraSetting | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const o = item as Record<string, unknown>;
  const cameraId = typeof o['cameraId'] === 'string' ? o['cameraId'] : '';
  if (!CAMERA_ID.test(cameraId)) return undefined;
  const name = typeof o['name'] === 'string' ? o['name'].trim().slice(0, 120) : '';
  if (!name) return undefined;
  const cam: LocalCameraSetting = { cameraId, name };
  const pos = o['position'];
  if (pos && typeof pos === 'object' && !Array.isArray(pos)) {
    const p = pos as Record<string, unknown>;
    if (isValidLatLon(p['latitude'], p['longitude'])) {
      const position: GeoPosition = { latitude: p['latitude'], longitude: p['longitude'] as number };
      if (typeof p['altitudeM'] === 'number' && Number.isFinite(p['altitudeM'])) {
        position.altitudeM = p['altitudeM'];
        position.altitudeDatum = 'msl';
      }
      cam.position = position;
    }
  }
  const heading = o['headingDegrees'];
  if (typeof heading === 'number' && Number.isFinite(heading)) cam.headingDegrees = ((heading % 360) + 360) % 360;
  if (o['gateway'] === 'direct' || o['gateway'] === 'go2rtc') cam.gateway = o['gateway'];
  if (typeof o['kind'] === 'string' && /^[a-z-]{1,16}$/.test(o['kind'])) cam.kind = o['kind'];
  return cam;
}

export function createProvider(): CamerasLocalProvider {
  return new CamerasLocalProvider();
}
