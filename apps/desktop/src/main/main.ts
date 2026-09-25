import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import { LoggerHub, type Logger } from '@worldview/core';
import { RotatingFileSink } from '@worldview/core/node';
import { StartupValidator, dataDirs, type StartupCheck } from '@worldview/config';
import { exportBundle } from '@worldview/diagnostics';
import {
  UpdaterController,
  createInertAutoUpdater,
  isNoFullReleaseMessage,
  loadElectronAutoUpdater,
  policyInputFromSettings,
  type AutoUpdaterLike,
} from '@worldview/updater';
import { wireChannel, type DefinitionsListing, type DiagnosticsSnapshot } from '@worldview/ipc-contract';
import type { HostBridge, RequestHandlers, WorldRuntime } from '@worldview/runtime';
import type { ProviderManifest } from '@worldview/provider-sdk';
import { MAP_PROVIDER_CATALOG } from '@worldview/render-core';
import { APP_ORIGIN, DEV_SERVER_ORIGIN, isTrustedRendererUrl } from '../shared/app-origin.js';
import { registerAppScheme, serveRenderer } from './app-protocol.js';
import { buildInfo } from './build-info.js';
import { CredentialStore, CredentialStoreError } from './credential-store.js';
import { IDENTIFIED_TILE_URLS, identifiedTileHeaders, mergeSecurityHeaders } from './csp.js';
import { buildExternalHostAllowlist, checkExternalUrl, type ExternalHostAllowlist } from './external-links.js';
import { IpcRouter, type IpcInvokeEventLike } from './ipc-router.js';
import { createRuntime } from './runtime-factory.js';
import { createMainWindow, hardenWebContents } from './window.js';
import { TileCache } from './tile-cache.js';
import { MemoryMonitor } from './memory-monitor.js';

/**
 * Main process bootstrap (ADR-004). Order matters:
 *  1. single-instance lock (before anything touches userData)
 *  2. logging → startup validation (data dir, migrations, settings, credentials)
 *  3. session hardening (CSP headers, permission denial) before any window exists
 *  4. runtime + updater + IPC router
 *  5. window
 */
const DEV = !app.isPackaged && process.env.WORLDVIEW_DEV === '1';
const NETWORK_POLL_MS = 15_000;

// Before whenReady on purpose: Chromium reads the scheme registry as the network service
// starts, and a scheme registered afterwards gets no origin — which is the one thing it is
// needed for. See src/main/app-protocol.ts.
registerAppScheme(protocol);

// Chromium's own HLS player (a <video> that plays an .m3u8). Chrome 142 turns it on for
// desktop by a server-side trial Electron never receives; its code is in Electron 39's
// Chromium (built with proprietary codecs), off by default. Without it a public camera's
// live HLS video cannot play in the window, and no third-party player is bundled. Whether it
// took is logged at startup ("renderer media", renderer-watchdog.ts).
app.commandLine.appendSwitch('enable-features', 'BuiltInHlsPlayer');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.worldview.desktop');
  void bootstrap().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    try {
      dialog.showErrorBox('WorldView could not start', message);
    } catch {
      /* headless */
    }
    console.error('fatal:', message);
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  const build = buildInfo();
  const dirs = dataDirs(app.getPath('userData'));

  const hub = new LoggerHub({
    level: DEV ? 'debug' : 'info',
    sinks: [new RotatingFileSink(dirs.logFile, { maxBytes: 5 * 1024 * 1024, keep: 3 })],
    // A warning repeated every poll is written once, then summarised every ten minutes.
    repeatWindowMs: 10 * 60_000,
  });
  const log = hub.logger('app');
  const security = hub.logger('security');
  process.on('uncaughtException', (err) => log.error('uncaught exception', { error: `${err.name}: ${err.message}` }));
  process.on('unhandledRejection', (reason) =>
    log.error('unhandled rejection', {
      error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
    }),
  );
  app.on('render-process-gone', (_e, _wc, details) =>
    log.error('render process gone', { reason: details.reason, exitCode: details.exitCode }),
  );
  app.on('child-process-gone', (_e, details) =>
    log.error('child process gone', { type: details.type, reason: details.reason, exitCode: details.exitCode }),
  );
  log.info('starting', {
    version: app.getVersion(),
    channel: build.channel,
    commit: build.commit,
    signed: build.signed,
    platform: process.platform,
    arch: process.arch,
    dev: DEV,
  });

  // Every WebContents — including ones we did not create on purpose — gets the same lockdown.
  const appDir = app.getAppPath();
  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents, { dev: DEV, appDir, logger: security }));
  hardenSession(DEV, security);
  if (app.isPackaged) Menu.setApplicationMenu(null);

  const credentials = new CredentialStore({ file: dirs.credentialsFile, safeStorage, logger: hub.logger('security') });
  const credentialCheck: StartupCheck = {
    name: 'credentials',
    area: 'credentials',
    run: async () => {
      const r = await credentials.load();
      const findings = [];
      if (r.status === 'corrupt')
        findings.push({
          area: 'credentials' as const,
          severity: 'warn' as const,
          message: 'credential file unreadable; stored keys must be entered again (file preserved)',
          file: 'credentials.json',
        });
      if (!credentials.encryptionAvailable)
        findings.push({
          area: 'credentials' as const,
          severity: 'warn' as const,
          message: 'OS secure storage unavailable; API keys cannot be saved on this system',
        });
      return findings;
    },
  };
  const startup = await new StartupValidator({ dirs, checks: [credentialCheck], logger: log }).run();
  if (!startup.usable) {
    dialog.showErrorBox(
      'WorldView cannot use its data directory',
      startup.findings
        .filter((f) => f.severity === 'error')
        .map((f) => f.message)
        .join('\n'),
    );
    app.exit(1);
    return;
  }
  const settings = startup.settings;

  // Map tiles kept on disk (tile-cache.ts): only catalog sources that allow it, under the
  // operator's size cap, with the world preload only when they switch it on.
  const tiles = new TileCache({
    dir: path.join(dirs.root, 'tiles'),
    sources: MAP_PROVIDER_CATALOG.flatMap((e) =>
      e.tileCache
        ? [
            {
              id: e.id,
              upstream: e.tileCache.upstream,
              maxZoom: e.tileCache.maxZoom,
              worldPreload: e.tileCache.worldPreload === 'operator-decides',
            },
          ]
        : [],
    ),
    fetch: (url, init) => net.fetch(url, init),
    maxMB: settings.get().tileCache.maxMB,
    logger: hub.logger('offline'),
  });
  // Process memory for Diagnostics and the log, every ten minutes (memory-monitor.ts).
  const appLog = hub.logger('app');
  const memory = new MemoryMonitor({
    metrics: () => app.getAppMetrics(),
    heapUsed: () => process.memoryUsage().heapUsed,
    now: () => Date.now(),
    log: (fields) => appLog.info('process memory', fields),
  });
  memory.start();
  app.on('will-quit', () => memory.stop());
  const { runtime } = await createRuntime({
    dirs,
    settings,
    credentials,
    logger: hub.logger('app'),
    loggerHub: hub,
    memoryInfo: () => memory.snapshot(),
    version: app.getVersion(),
    commit: build.commit,
    channel: build.channel,
    platform: process.platform,
    host: electronHostBridge(),
    network: { isOnline: () => net.isOnline() },
    cachedTileSources: () => tiles.sourcesWithTiles(),
    resourcesDir: bundledResourcesDir(appDir),
    // The label file the map draws place names from; the same file makes them searchable.
    referenceLabelsPath: DEV
      ? path.join(appDir, 'assets', 'reference', 'labels.json')
      : path.join(appDir, 'dist', 'renderer', 'reference', 'labels.json'),
    build: { signed: build.signed, packaged: app.isPackaged },
    runtimeInfo: () => ({
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    }),
  });
  await runtime.start();

  // An app that cannot check for updates should still show you a globe. Before this, any
  // throw here became "WorldView could not start" with the raw message and no window at
  // all — which is how a one-line interop bug in electron-updater stopped the packaged
  // build dead. Degrade to the inert updater and say so loudly instead.
  const autoUpdater = await resolveAutoUpdater(app.isPackaged, hub.logger('updater'));
  const updater = new UpdaterController({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    policy: () => policyInputFromSettings(settings.get().updater, { signed: build.signed, packaged: app.isPackaged }),
    logger: hub.logger('updater'),
  });
  settings.onChange(() => updater.applyPolicy());

  void tiles
    .init()
    .catch((err: unknown) =>
      log.warn('tile cache could not read its directory', { error: err instanceof Error ? err.message : String(err) }),
    );
  const applyTileSettings = () => {
    const s = settings.get();
    tiles.configure(s.tileCache, s.basemapId);
  };
  applyTileSettings();
  settings.onChange(applyTileSettings);
  app.on('will-quit', () => tiles.dispose());

  const allowlist = lazyExternalAllowlist(runtime, log);
  const overrides: Partial<RequestHandlers> = {
    'app.info': async () => ({
      version: app.getVersion(),
      channel: build.channel,
      commit: build.commit,
      demoMode: settings.get().demoMode,
      platform: process.platform,
    }),
    'app.openExternal': async ({ url }) => {
      const verdict = checkExternalUrl(url, await allowlist());
      if (!verdict.allowed) {
        security.warn('openExternal refused', { host: verdict.host ?? '', reason: verdict.reason ?? '' });
        throw Object.assign(new Error(verdict.reason ?? 'refused'), { ipcCode: 'DENIED' as const });
      }
      await shell.openExternal(url);
      return { opened: true };
    },
    // The operator's connector-definition folder in the OS file manager (ADR-013 amendment).
    // The path comes from the runtime, never from the renderer.
    'sources.definitions.openFolder': async (_req, ctx) => {
      const { folder } = (await runtime.handlers['sources.definitions.list'](undefined, ctx)) as DefinitionsListing;
      if (!folder) return { opened: false, folder: null };
      await fs.mkdir(folder, { recursive: true });
      const failure = await shell.openPath(folder);
      if (failure) log.warn('definition folder could not be opened', { error: failure });
      return { opened: failure === '', folder };
    },
    'credentials.has': async ({ key }) => ({ present: await credentials.has(key) }),
    'credentials.set': async ({ key, value }) => {
      await withCredentialErrors(() => credentials.set(key, value));
    },
    'credentials.delete': async ({ key }) => {
      await withCredentialErrors(() => credentials.delete(key));
    },
    'tiles.status': async () => tiles.status(),
    'tiles.clear': async () => tiles.clear(),
    'tiles.prefetch': async ({ sourceId, bounds, zoom }) => {
      tiles.prefetch(sourceId, bounds, zoom);
    },
    'updater.state': async () => updater.state(),
    'updater.check': async () => updater.check(),
    'updater.install': async () => updater.install(),
    'diagnostics.export': async (_req, ctx) => {
      const win = BrowserWindow.getAllWindows()[0];
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const opts = {
        title: 'Export diagnostics bundle',
        defaultPath: path.join(app.getPath('downloads'), `worldview-diagnostics-${stamp}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      };
      const chosen = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (chosen.canceled || !chosen.filePath) return { cancelled: true } as const;
      const snapshot = (await runtime.handlers['diagnostics.get'](undefined, ctx)) as DiagnosticsSnapshot;
      await exportBundle(path.dirname(chosen.filePath), {
        snapshot,
        logFile: dirs.logFile,
        findings: startup.findings.map((f) => ({ ...f })),
        fileName: path.basename(chosen.filePath),
        extraRoots: [dirs.root],
      });
      return { path: chosen.filePath, redacted: true } as const;
    },
  };

  const router = new IpcRouter({
    ipcMain,
    runtime,
    overrides,
    logger: hub.logger('ipc'),
    isTrustedSender: (e) => isTrustedSender(e, DEV, appDir),
  });
  router.register();

  // The updater lives in main, not in the runtime, so its state is pushed to windows directly on the contract's event channel.
  updater.onChange((state) => {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send(wireChannel('updater.changed'), state);
  });

  if (Notification.isSupported()) {
    runtime.on('notification', (n) => {
      const note = new Notification({
        title: n.title.slice(0, 120),
        body: n.body.slice(0, 400),
        silent: n.severity === 'INFO',
      });
      note.show();
    });
  }

  const pollNetwork = () => runtime.setNetworkOnline(net.isOnline());
  pollNetwork();
  const networkTimer = setInterval(pollNetwork, NETWORK_POLL_MS);

  const preloadPath = path.join(appDir, 'dist', 'preload', 'preload.cjs');
  if (!DEV)
    serveRenderer(
      protocol,
      path.join(appDir, 'dist', 'renderer'),
      (message) => security.warn('renderer asset', { message }),
      { tiles: (pathname) => tiles.respond(pathname) },
    );
  const entry = DEV
    ? ({ kind: 'url', url: `${DEV_SERVER_ORIGIN}/` } as const)
    : ({ kind: 'url', url: `${APP_ORIGIN}/` } as const);
  const open = () => {
    const win = createMainWindow({
      preloadPath,
      entry,
      appDir,
      dev: DEV,
      logger: security,
      rendererLogger: hub.logger('renderer'),
    });
    const detach = router.attachWindow(win.webContents);
    win.on('closed', detach);
    return win;
  };
  let main = open();

  app.on('second-instance', () => {
    if (main.isDestroyed()) main = open();
    if (main.isMinimized()) main.restore();
    main.focus();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) main = open();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    clearInterval(networkTimer);
    router.dispose();
    updater.dispose();
    void runtime
      .stop()
      .catch((err: unknown) =>
        log.error('runtime stop failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    void hub.flush();
  });
}

/**
 * The capabilities the runtime genuinely needs from Electron: native dialogs, the OS
 * browser and OS notifications. Everything else it does itself.
 */
function electronHostBridge(): HostBridge {
  const parent = () => BrowserWindow.getAllWindows()[0];
  return {
    pickOpenFile: async (opts) => {
      const win = parent();
      const options = {
        title: opts.title,
        properties: ['openFile' as const],
        ...(opts.filters ? { filters: opts.filters } : {}),
      };
      const chosen = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      const file = chosen.filePaths[0];
      return chosen.canceled || !file ? { cancelled: true } : { path: file };
    },
    pickSaveFile: async (opts) => {
      const win = parent();
      const options = {
        title: opts.title,
        ...(opts.defaultPath ? { defaultPath: opts.defaultPath } : {}),
        ...(opts.filters ? { filters: opts.filters } : {}),
      };
      const chosen = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      return chosen.canceled || !chosen.filePath ? { cancelled: true } : { path: chosen.filePath };
    },
    openExternal: async (url) => {
      await shell.openExternal(url);
      return true;
    },
    showNotification: (n) => {
      if (!Notification.isSupported()) return;
      new Notification({ title: n.title.slice(0, 120), body: n.body.slice(0, 400) }).show();
    },
    appPaths: () => ({ downloads: app.getPath('downloads') }),
  };
}

/**
 * Read-only bundled data the filesystem providers are granted (the seed airports
 * dataset). Packaged builds ship it under `resources/data`; a dev run reads it from the
 * repository's `fixtures` tree.
 */
/**
 * The real updater when packaged, the inert one otherwise — and the inert one rather than
 * a failed startup if electron-updater will not load. Updates stopping is bad; the
 * application refusing to open is worse, and the log records which happened.
 */
async function resolveAutoUpdater(packaged: boolean, log: Logger): Promise<AutoUpdaterLike> {
  if (!packaged) return createInertAutoUpdater();
  try {
    return await loadElectronAutoUpdater({ logger: updaterLog(log) });
  } catch (error) {
    log.error('electron-updater failed to load; this build cannot check for updates', {
      error: error instanceof Error ? error.message : String(error),
    });
    return createInertAutoUpdater();
  }
}

function bundledResourcesDir(appDir: string): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return app.isPackaged && resourcesPath ? path.join(resourcesPath, 'data') : path.join(appDir, 'resources', 'data');
}

/** CSP + permission lockdown on the default session, before any window loads. */
function hardenSession(dev: boolean, security: Logger): void {
  const s = session.defaultSession;
  s.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: mergeSecurityHeaders(details.responseHeaders, { dev }) });
  });
  s.webRequest.onBeforeSendHeaders({ urls: IDENTIFIED_TILE_URLS }, (details, callback) => {
    callback({ requestHeaders: identifiedTileHeaders(details.requestHeaders, app.getVersion()) });
  });
  s.setPermissionRequestHandler((_wc, permission, callback, details) => {
    security.warn('permission request denied', { permission, url: (details.requestingUrl ?? '').slice(0, 120) });
    callback(false);
  });
  s.setPermissionCheckHandler(() => false);
  s.setDevicePermissionHandler(() => false);
  s.setSpellCheckerEnabled(false);
}

function isTrustedSender(event: IpcInvokeEventLike, dev: boolean, appDir: string): boolean {
  const url = event.senderFrame?.url;
  if (!url) return false;
  return isTrustedRendererUrl(url, { dev, appDir });
}

/** Attribution/terms hosts from every registered provider manifest, resolved once through the runtime. */
function lazyExternalAllowlist(runtime: WorldRuntime, log: Logger): () => Promise<ExternalHostAllowlist> {
  let cached: ExternalHostAllowlist | undefined;
  return async () => {
    if (cached) return cached;
    const ctx = { clientId: 'main', signal: new AbortController().signal };
    const manifests: ProviderManifest[] = [];
    try {
      const entries = await runtime.handlers['sources.list'](undefined, ctx);
      for (const e of entries) {
        const m = await runtime.handlers['sources.manifest']({ providerId: e.providerId }, ctx);
        if (m) manifests.push(m);
      }
    } catch (err) {
      log.warn('external allowlist: could not read provider manifests; using static hosts only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    cached = buildExternalHostAllowlist(manifests);
    return cached;
  };
}

async function withCredentialErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CredentialStoreError) {
      const code = err.code === 'ENCRYPTION_UNAVAILABLE' ? 'UNAVAILABLE' : 'INVALID_REQUEST';
      throw Object.assign(new Error(err.message), { ipcCode: code as 'UNAVAILABLE' | 'INVALID_REQUEST' });
    }
    throw err;
  }
}

function updaterLog(logger: Logger): {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
  debug(m: string): void;
} {
  return {
    info: (m) => logger.info(String(m)),
    warn: (m) => logger.warn(String(m)),
    // electron-updater logs its own copy of every failure; "no full release yet" is not one.
    error: (m) =>
      isNoFullReleaseMessage(String(m)) ? logger.info('no full release on this channel') : logger.error(String(m)),
    debug: (m) => logger.debug(String(m)),
  };
}
