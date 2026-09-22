/**
 * Declaration shim for `electron-updater` — used ONLY when the real package is not
 * installed (tools/dev/typecheck.mjs maps it in and records that in evidence).
 * Declares the documented surface of electron-updater ≥ 6 that
 * packages/updater/src/electron-adapter.ts uses: `autoUpdater` (an AppUpdater) with
 * the autoDownload / autoInstallOnAppQuit / allowPrerelease / allowDowngrade flags,
 * checkForUpdates / downloadUpdate / quitAndInstall and the standard events.
 */
export interface UpdateFileInfo {
  url: string;
  sha512: string;
  size?: number;
  blockMapSize?: number;
}

export interface UpdateInfo {
  version: string;
  files: UpdateFileInfo[];
  path?: string;
  sha512?: string;
  releaseName?: string | null;
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null;
  releaseDate: string;
  stagingPercentage?: number;
}

export interface UpdateDownloadedEvent extends UpdateInfo {
  downloadedFile: string;
}

export interface ProgressInfo {
  total: number;
  delta: number;
  transferred: number;
  percent: number;
  bytesPerSecond: number;
}

export interface CancellationToken {
  cancel(): void;
  readonly cancelled: boolean;
}

export interface UpdateCheckResult {
  updateInfo: UpdateInfo;
  downloadPromise?: Promise<string[]> | null;
  cancellationToken?: CancellationToken;
  versionInfo: UpdateInfo;
}

export interface Logger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug?(message: string): void;
}

export declare class AppUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  fullChangelog: boolean;
  channel: string | null;
  logger: Logger | null;
  readonly currentVersion: { readonly version: string };
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  checkForUpdatesAndNotify(): Promise<UpdateCheckResult | null>;
  downloadUpdate(cancellationToken?: CancellationToken): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  setFeedURL(
    options:
      | { provider: 'github'; owner: string; repo: string; releaseType?: 'release' | 'prerelease' | 'draft' }
      | string,
  ): void;
  on(event: 'checking-for-update', listener: () => void): this;
  on(event: 'update-available', listener: (info: UpdateInfo) => void): this;
  on(event: 'update-not-available', listener: (info: UpdateInfo) => void): this;
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): this;
  on(event: 'update-downloaded', listener: (event: UpdateDownloadedEvent) => void): this;
  on(event: 'error', listener: (error: Error, message?: string) => void): this;
  on(event: 'update-cancelled', listener: (info: UpdateInfo) => void): this;
  off(event: string, listener: (...args: never[]) => void): this;
  removeAllListeners(event?: string): this;
}

export declare const autoUpdater: AppUpdater;
