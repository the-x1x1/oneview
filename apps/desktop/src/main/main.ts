import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, safeStorage, session, shell } from 'electron';
import { LoggerHub, type Logger } from '@worldview/core';
import { RotatingFileSink } from '@worldview/core/node';
import { StartupValidator, dataDirs, type StartupCheck } from '@worldview/config';
import { exportBundle } from '@worldview/diagnostics';
import { UpdaterController, createInertAutoUpdater, loadElectronAutoUpdater, policyInputFromSettings } from '@worldview/updater';
import { wireChannel, type DiagnosticsSnapshot } from '@worldview/ipc-contract';
import type { RequestHandlers, WorldRuntime } from '@worldview/runtime';
import type { ProviderManifest } from '@worldview/provider-sdk';
import { DEV_SERVER_ORIGIN, isTrustedRendererUrl } from '../shared/app-origin.js';
import { buildInfo } from './build-info.js';
import { CredentialStore, CredentialStoreError } from './credential-store.js';
import { mergeSecurityHeaders } from './csp.js';
import { buildExternalHostAllowlist, checkExternalUrl, type ExternalHostAllowlist } from './external-links.js';
import { IpcRouter, type IpcInvokeEventLike } from './ipc-router.js';
import { createRuntime } from './runtime-factory.js';
import { createMainWindow, hardenWebContents } from './window.js';

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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.worldview.desktop');
  void bootstrap().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    try { dialog.showErrorBox('WorldView could not start', message); } catch { /* headless */ }
    console.error('fatal:', message);
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  const build = buildInfo();
  const dirs = dataDirs(app.getPath('userData'));

  const hub = new LoggerHub({ level: DEV ? 'debug' : 'info', sinks: [new RotatingFileSink(dirs.logFile, { maxBytes: 5 * 1024 * 1024, keep: 3 })] });
  const log = hub.logger('app');
  const security = hub.logger('security');
  process.on('uncaughtException', (err) => log.error('uncaught exception', { error: `${err.name}: ${err.message}` }));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason) }));
  app.on('render-process-gone', (_e, _wc, details) => log.error('render process gone', { reason: details.reason, exitCode: details.exitCode }));
  app.on('child-process-gone', (_e, details) => log.error('child process gone', { type: details.type, reason: details.reason, exitCode: details.exitCode }));
  log.info('starting', { version: app.getVersion(), channel: build.channel, commit: build.commit, signed: build.signed, platform: process.platform, arch: process.arch, dev: DEV });

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
      if (r.status === 'corrupt') findings.push({ area: 'credentials' as const, severity: 'warn' as const, message: 'credential file unreadable; stored keys must be entered again (file preserved)', file: 'credentials.json' });
      if (!credentials.encryptionAvailable) findings.push({ area: 'credentials' as const, severity: 'warn' as const, message: 'OS secure storage unavailable; API keys cannot be saved on this system' });
      return findings;
    },
  };
  const startup = await new StartupValidator({ dirs, checks: [credentialCheck], logger: log }).run();
  if (!startup.usable) {
    dialog.showErrorBox('WorldView cannot use its data directory', startup.findings.filter((f) => f.severity === 'error').map((f) => f.message).join('\n'));
    app.exit(1);
    return;
  }
  const settings = startup.settings;

  const { runtime, kind: runtimeKind } = await createRuntime({ dirs, settings, credentials, logger: hub.logger('app'), version: app.getVersion(), commit: build.commit, channel: build.channel, platform: process.platform });
  await runtime.start();

  const autoUpdater = app.isPackaged ? await loadElectronAutoUpdater({ logger: updaterLog(hub.logger('updater')) }) : createInertAutoUpdater();
  const updater = new UpdaterController({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    policy: () => policyInputFromSettings(settings.get().updater, { signed: build.signed, packaged: app.isPackaged }),
    logger: hub.logger('updater'),
  });
  settings.onChange(() => updater.applyPolicy());

  const allowlist = lazyExternalAllowlist(runtime, log);
  const overrides: Partial<RequestHandlers> = {
    'app.info': async () => ({ version: app.getVersion(), channel: build.channel, commit: build.commit, demoMode: settings.get().demoMode, platform: process.platform }),
    'app.openExternal': async ({ url }) => {
      const verdict = checkExternalUrl(url, await allowlist());
      if (!verdict.allowed) {
        security.warn('openExternal refused', { host: verdict.host ?? '', reason: verdict.reason ?? '' });
        throw Object.assign(new Error(verdict.reason ?? 'refused'), { ipcCode: 'DENIED' as const });
      }
      await shell.openExternal(url);
      return { opened: true };
    },
    'credentials.has': async ({ key }) => ({ present: await credentials.has(key) }),
    'credentials.set': async ({ key, value }) => { await withCredentialErrors(() => credentials.set(key, value)); },
    'credentials.delete': async ({ key }) => { await withCredentialErrors(() => credentials.delete(key)); },
    'updater.state': async () => updater.state(),
    'updater.check': async () => updater.check(),
    'updater.install': async () => updater.install(),
    'diagnostics.export': async (_req, ctx) => {
      const win = BrowserWindow.getAllWindows()[0];
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const opts = { title: 'Export diagnostics bundle', defaultPath: path.join(app.getPath('downloads'), `worldview-diagnostics-${stamp}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] };
      const chosen = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (chosen.canceled || !chosen.filePath) return { cancelled: true } as const;
      const snapshot = (await runtime.handlers['diagnostics.get'](undefined, ctx)) as DiagnosticsSnapshot;
      await exportBundle(path.dirname(chosen.filePath), { snapshot, logFile: dirs.logFile, findings: startup.findings.map((f) => ({ ...f })), fileName: path.basename(chosen.filePath), extraRoots: [dirs.root] });
      return { path: chosen.filePath, redacted: true } as const;
    },
  };

  const router = new IpcRouter({ ipcMain, runtime, overrides, logger: hub.logger('ipc'), isTrustedSender: (e) => isTrustedSender(e, DEV, appDir) });
  router.register();

  // The updater lives in main, not in the runtime, so its state is pushed to windows directly on the contract's event channel.
  updater.onChange((state) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(wireChannel('updater.changed'), state); });

  if (Notification.isSupported()) {
    runtime.on('notification', (n) => {
      const note = new Notification({ title: n.title.slice(0, 120), body: n.body.slice(0, 400), silent: n.severity === 'INFO' });
      note.show();
    });
  }

  const pollNetwork = () => runtime.setNetworkOnline(net.isOnline());
  pollNetwork();
  const networkTimer = setInterval(pollNetwork, NETWORK_POLL_MS);

  const preloadPath = path.join(appDir, 'dist', 'preload', 'preload.cjs');
  const entry = DEV ? ({ kind: 'url', url: `${DEV_SERVER_ORIGIN}/` } as const) : ({ kind: 'file', path: path.join(appDir, 'dist', 'renderer', 'index.html') } as const);
  const open = () => {
    const win = createMainWindow({ preloadPath, entry, appDir, dev: DEV, logger: security });
    const detach = router.attachWindow(win.webContents);
    win.on('closed', detach);
    return win;
  };
  let main = open();
  if (runtimeKind === 'stub') log.warn('running with the StubRuntime: only app.info and settings.* answer; wire @worldview/runtime createWorldRuntime');

  app.on('second-instance', () => {
    if (main.isDestroyed()) main = open();
    if (main.isMinimized()) main.restore();
    main.focus();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) main = open(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => {
    clearInterval(networkTimer);
    router.dispose();
    updater.dispose();
    void runtime.stop().catch((err: unknown) => log.error('runtime stop failed', { error: err instanceof Error ? err.message : String(err) }));
    void hub.flush();
  });
}

/** CSP + permission lockdown on the default session, before any window loads. */
function hardenSession(dev: boolean, security: Logger): void {
  const s = session.defaultSession;
  s.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: mergeSecurityHeaders(details.responseHeaders, { dev }) });
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
      log.warn('external allowlist: could not read provider manifests; using static hosts only', { error: err instanceof Error ? err.message : String(err) });
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

function updaterLog(logger: Logger): { info(m: string): void; warn(m: string): void; error(m: string): void; debug(m: string): void } {
  return {
    info: (m) => logger.info(String(m)),
    warn: (m) => logger.warn(String(m)),
    error: (m) => logger.error(String(m)),
    debug: (m) => logger.debug(String(m)),
  };
}
