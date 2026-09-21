import { BrowserWindow, type WebContents } from 'electron';
import type { Logger } from '@worldview/core';
import { isTrustedRendererUrl } from '../shared/app-origin.js';

export interface MainWindowOptions {
  preloadPath: string;
  /** Production: absolute path to renderer/index.html. Development: the Vite URL. */
  entry: { kind: 'file'; path: string } | { kind: 'url'; url: string };
  appDir: string;
  dev: boolean;
  logger: Logger;
  iconPath?: string;
}

/**
 * Locks down one WebContents (ADR-004): no popups, no navigation off the app
 * origin, no <webview>, no permission grants. Applied to every WebContents the app
 * creates (main.ts hooks `web-contents-created`) so the rules hold even for
 * contents we did not anticipate.
 */
export function hardenWebContents(contents: WebContents, opts: { dev: boolean; appDir: string; logger: Logger }): void {
  contents.setWindowOpenHandler((details) => {
    opts.logger.warn('security: window.open blocked', { url: details.url.slice(0, 200) });
    return { action: 'deny' };
  });
  const guard = (event: { preventDefault(): void }, url: string, what: string) => {
    if (isTrustedRendererUrl(url, { dev: opts.dev, appDir: opts.appDir })) return;
    event.preventDefault();
    opts.logger.warn(`security: ${what} blocked`, { url: url.slice(0, 200) });
  };
  contents.on('will-navigate', (event, url) => guard(event, url, 'navigation'));
  contents.on('will-redirect', (event, url) => guard(event, url, 'redirect'));
  contents.on('will-attach-webview', (event) => { event.preventDefault(); opts.logger.warn('security: webview blocked'); });
  contents.on('render-process-gone', (_e, details) => opts.logger.error('renderer process gone', { reason: details.reason, exitCode: details.exitCode }));
  contents.on('unresponsive', () => opts.logger.warn('renderer unresponsive'));
  contents.on('preload-error', (_e, preloadPath, error) => opts.logger.error('preload failed', { preload: preloadPath.slice(-60), error: error.message }));
}

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'WorldView',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    ...(opts.iconPath ? { icon: opts.iconPath } : {}),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      enableWebSQL: false,
      experimentalFeatures: false,
      devTools: opts.dev,
    },
  });
  hardenWebContents(win.webContents, { dev: opts.dev, appDir: opts.appDir, logger: opts.logger });
  win.once('ready-to-show', () => win.show());
  const load = opts.entry.kind === 'file' ? win.loadFile(opts.entry.path) : win.loadURL(opts.entry.url);
  load.catch((err: unknown) => opts.logger.error('renderer failed to load', { error: err instanceof Error ? err.message : String(err) }));
  return win;
}
