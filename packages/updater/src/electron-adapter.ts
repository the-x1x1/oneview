import type { AutoUpdaterLike } from './controller.js';

/** What `electron-updater`'s namespace looks like once Node has interop'd it. */
interface ElectronUpdaterModule {
  autoUpdater?: AutoUpdaterLike & { logger?: unknown };
  default?: { autoUpdater?: AutoUpdaterLike & { logger?: unknown } };
}

/**
 * `electron-updater` is CommonJS, and it exports `autoUpdater` like this:
 *
 *     Object.defineProperty(exports, "autoUpdater", {
 *       enumerable: true,
 *       get: () => _autoUpdater || doLoadAutoUpdater(),
 *     });
 *
 * Node's `cjs-module-lexer` only recognises `get: function () { return X; }` as a named
 * export, so an arrow function with an expression body is invisible to it: the namespace
 * object has no `autoUpdater` at all, and the binding survives only on `default`.
 *
 * Reading `mod.autoUpdater` therefore returned `undefined`, and the next line —
 * `updater.logger = …` — threw "Cannot set properties of undefined (setting 'logger')".
 * The packaged app refused to start, while `pnpm dev` was fine, because this is the only
 * code path gated on `app.isPackaged`.
 *
 * Same family as maplibre-gl and pmtiles putting their members on `default`; the lesson is
 * that a CJS package's named exports are a guess Node makes by reading the source, not a
 * guarantee. Take whichever position holds it.
 */
function resolveAutoUpdater(mod: ElectronUpdaterModule): AutoUpdaterLike & { logger?: unknown } {
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!updater) {
    throw new Error(
      'electron-updater loaded but exposed no `autoUpdater` on either the namespace or `default`; ' +
        'the app cannot check for updates. This usually means the package shape changed.',
    );
  }
  return updater;
}

/**
 * Binds electron-updater's `autoUpdater` (GitHub provider, configured by
 * apps/desktop/electron-builder.yml `publish`) to the AutoUpdaterLike surface.
 * Loaded lazily so tests and tools never require electron-updater.
 */
export async function loadElectronAutoUpdater(opts: { logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void; debug(msg: string): void } } = {}): Promise<AutoUpdaterLike> {
  const mod = (await import('electron-updater')) as unknown as ElectronUpdaterModule;
  const updater = resolveAutoUpdater(mod);
  if (opts.logger) updater.logger = opts.logger;
  // Signature verification of the downloaded installer is electron-updater's job
  // (Windows: verifies the Authenticode signature against the publisher name of the
  // running binary). We never disable it.
  return updater;
}

/** Exported for tests: the interop rule, without importing electron-updater. */
export const __resolveAutoUpdaterForTest = resolveAutoUpdater;
