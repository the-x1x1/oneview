/**
 * The GPU the page draws with, as WebGL reports it, for Diagnostics. Chromium exposes the
 * unmasked renderer string (`WEBGL_debug_renderer_info`) to pages; where it does not, the
 * masked one is used. Probed once, on a throwaway canvas.
 */
let cached: string | null | undefined;

export function gpuRenderer(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;
  cached = null;
  try {
    if (typeof document === 'undefined') return undefined;
    const gl =
      document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
    if (!gl) return undefined;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const value = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) as unknown;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (typeof value === 'string' && value.trim()) cached = value.trim().slice(0, 256);
  } catch {
    cached = null;
  }
  return cached ?? undefined;
}
