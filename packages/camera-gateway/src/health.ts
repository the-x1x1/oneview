import type { Clock } from '@worldview/world-model';
import type { CameraError } from './errors.js';
import type { CameraHealth } from './types.js';

/** Per-camera health bookkeeping shared by both gateways. Never stores frames or URLs. */
export class CameraHealthTracker {
  private readonly map = new Map<string, CameraHealth>();
  constructor(private readonly clock: Clock) {}

  get(cameraId: string): CameraHealth {
    return this.map.get(cameraId) ?? { status: 'unknown' };
  }

  success(cameraId: string): void {
    const at = new Date(this.clock.now()).toISOString();
    const prev = this.map.get(cameraId);
    const next: CameraHealth = { status: 'ok', lastSuccessAt: at };
    if (prev?.lastErrorAt) next.lastErrorAt = prev.lastErrorAt;
    this.map.set(cameraId, next);
  }

  failure(cameraId: string, err: CameraError): void {
    const at = new Date(this.clock.now()).toISOString();
    const prev = this.map.get(cameraId);
    const next: CameraHealth = {
      status: prev?.lastSuccessAt && err.retryable ? 'degraded' : 'unavailable',
      lastErrorAt: at,
      lastError: err.toInfo(),
    };
    if (prev?.lastSuccessAt) next.lastSuccessAt = prev.lastSuccessAt;
    this.map.set(cameraId, next);
  }

  remove(cameraId: string): void { this.map.delete(cameraId); }

  counts(ids: Iterable<string>): { ok: number; degraded: number; unavailable: number; unknown: number } {
    const c = { ok: 0, degraded: 0, unavailable: 0, unknown: 0 };
    for (const id of ids) c[this.get(id).status]++;
    return c;
  }
}
