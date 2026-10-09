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

/**
 * What the map says when this computer gives the page no WebGL2 — instead of the 2D library's
 * own "we are sorry" text, which names neither the cause nor that everything else still works.
 * On Linux the usual causes are a missing Mesa driver, a GPU Chromium has blocklisted, or a
 * remote/virtual display; Diagnostics shows which GPU (if any) the page saw.
 */
export function noWebGlMessage(platform: string | undefined): string {
  const base =
    'This computer gave WORLDVIEW no hardware 3D graphics (WebGL2), so the map cannot be drawn. ' +
    'Search, sources, the feed, history and exports still work.';
  if (platform === 'linux')
    return `${base} On Linux, check that the Mesa graphics driver is installed, and that you are not on a remote or virtual display; Settings → Diagnostics shows the GPU the window saw.`;
  return `${base} Update the graphics driver; Settings → Diagnostics shows the GPU the window saw.`;
}
