import type { AutoUpdaterLike } from './controller.js';

/**
 * Binds electron-updater's `autoUpdater` (GitHub provider, configured by
 * apps/desktop/electron-builder.yml `publish`) to the AutoUpdaterLike surface.
 * Loaded lazily so tests and tools never require electron-updater.
 */
export async function loadElectronAutoUpdater(opts: { logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void; debug(msg: string): void } } = {}): Promise<AutoUpdaterLike> {
  const mod = await import('electron-updater');
  const updater = mod.autoUpdater;
  if (opts.logger) updater.logger = opts.logger;
  // Signature verification of the downloaded installer is electron-updater's job
  // (Windows: verifies the Authenticode signature against the publisher name of the
  // running binary). We never disable it.
  return updater;
}
