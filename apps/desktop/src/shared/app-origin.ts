/**
 * Where the renderer is allowed to live. Production loads the bundled index.html
 * from the app's own directory (file: URL under app.getAppPath()); development
 * loads the Vite dev server. Navigation anywhere else is blocked in main.
 * Shared between main, preload and tests; imports nothing from Node.
 */
export const DEV_SERVER_ORIGIN = 'http://localhost:5173';

export function isTrustedRendererUrl(url: string, opts: { dev: boolean; appDir?: string }): boolean {
  if (opts.dev) return url === DEV_SERVER_ORIGIN || url.startsWith(`${DEV_SERVER_ORIGIN}/`);
  if (!url.startsWith('file:')) return false;
  if (!opts.appDir) return false;
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(url).pathname); } catch { return false; }
  const normalizedDir = opts.appDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const withLeadingSlash = normalizedDir.startsWith('/') ? normalizedDir : `/${normalizedDir}`;
  return pathname.startsWith(`${withLeadingSlash}/`) && !pathname.includes('/../');
}
