import type { RendererEvents } from '@worldview/render-core';

/**
 * A frame sample's 3D model counts as the perf line's `models` field: `on s12 n4 a4 d4 i4`
 * — on or off, features with a model scanned, near the camera, assigned, drawn, instances —
 * and `fail:<kinds>` when a file did not load, cut at the 40 characters the log keeps
 * (main/renderer-watchdog.ts). Empty when the renderer has no models (2D).
 */
export function modelsField(m: RendererEvents['frame']['models']): string {
  if (!m) return '';
  const counts = `s${m.scanned} n${m.near} a${m.assigned} d${m.drawn} i${m.instances}`;
  return `${m.enabled ? 'on' : 'off'} ${counts}${m.failed.length ? ` fail:${m.failed.join(',')}` : ''}`.slice(0, 40);
}
