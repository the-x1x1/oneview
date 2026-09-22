import type { UpdaterState } from '@worldview/ipc-contract';
import { TypedEmitter, redactText, silentLogger, type Logger } from '@worldview/core';
import {
  isAcceptableUpdate,
  resolveUpdatePolicy,
  type UpdatePolicyDecision,
  type UpdatePolicyInput,
} from './policy.js';

/** The subset of electron-updater's `AppUpdater` the controller uses (tests inject a fake). */
export interface UpdateInfoLike {
  version: string;
  releaseName?: string | null;
  releaseDate?: string;
}
export interface UpdateCheckResultLike {
  updateInfo: UpdateInfoLike;
}
export interface ProgressInfoLike {
  percent: number;
  transferred: number;
  total: number;
}

export type AutoUpdaterEvent =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error';

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<UpdateCheckResultLike | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'update-not-available', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'download-progress', listener: (progress: ProgressInfoLike) => void): unknown;
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeAllListeners?(event?: AutoUpdaterEvent): unknown;
}

export interface UpdaterControllerOptions {
  updater: AutoUpdaterLike;
  currentVersion: string;
  /** Read on every decision so settings changes take effect without restart. */
  policy: () => UpdatePolicyInput;
  logger?: Logger;
  now?: () => number;
}

/**
 * UpdaterController — owns the UpdaterState the shell displays and applies the
 * trust policy to electron-updater. Every transition is an emitted state; the IPC
 * layer forwards it as `updater.changed`.
 */
export class UpdaterController {
  private readonly emitter = new TypedEmitter<{ change: UpdaterState }>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private current: UpdaterState;
  private decision: UpdatePolicyDecision;
  private progress: ProgressInfoLike | undefined;

  constructor(private readonly opts: UpdaterControllerOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
    const input = opts.policy();
    this.decision = resolveUpdatePolicy(input);
    this.current = {
      channel: input.channel,
      automatic: this.decision.autoDownload,
      status: this.decision.enabled ? 'idle' : 'disabled',
      currentVersion: opts.currentVersion,
      signed: input.signed,
      message: this.decision.reason,
    };
    this.applyPolicy();
    this.wire();
  }

  state(): UpdaterState {
    return { ...this.current };
  }
  policy(): UpdatePolicyDecision {
    return { ...this.decision };
  }
  onChange(listener: (state: UpdaterState) => void): () => void {
    return this.emitter.on('change', listener);
  }

  /** Re-read settings → policy → updater flags. Call whenever settings.updater changes. */
  applyPolicy(): void {
    const input = this.opts.policy();
    this.decision = resolveUpdatePolicy(input);
    const u = this.opts.updater;
    u.autoDownload = this.decision.autoDownload;
    u.autoInstallOnAppQuit = this.decision.autoInstallOnAppQuit;
    u.allowPrerelease = this.decision.allowPrerelease;
    u.allowDowngrade = false;
    const patch: Partial<UpdaterState> = {
      channel: input.channel,
      automatic: this.decision.autoDownload,
      signed: input.signed,
    };
    if (!this.decision.enabled) {
      patch.status = 'disabled';
      patch.message = this.decision.reason;
    } else if (this.current.status === 'disabled') {
      patch.status = 'idle';
      patch.message = this.decision.reason;
    }
    this.update(patch);
  }

  async check(): Promise<UpdaterState> {
    if (!this.decision.enabled) return this.state();
    if (this.current.status === 'checking' || this.current.status === 'downloading') return this.state();
    this.update({
      status: 'checking',
      message: 'checking for updates',
      lastCheckedAt: new Date(this.now()).toISOString(),
    });
    try {
      const result = await this.opts.updater.checkForUpdates();
      // Events normally settle the state; when they did not (some providers resolve without emitting), settle from the result.
      if (this.statusNow() === 'checking') {
        if (result?.updateInfo) this.onAvailable(result.updateInfo);
        else this.update({ status: 'up-to-date', message: 'no update information available' });
      }
    } catch (err) {
      this.onError(err);
    }
    return this.state();
  }

  /** Explicit user action. Downloads (if needed) and installs. Unsigned builds are allowed here because the user asked. */
  async install(): Promise<UpdaterState> {
    if (!this.decision.enabled) return this.state();
    if (this.current.status === 'downloaded') {
      this.logger.info('installing downloaded update', {
        version: this.current.availableVersion ?? 'unknown',
        signed: this.current.signed,
      });
      this.opts.updater.quitAndInstall(false, true);
      return this.state();
    }
    if (this.current.status !== 'available') {
      this.update({ message: 'no update is available to install' });
      return this.state();
    }
    this.update({
      status: 'downloading',
      message: this.current.signed
        ? 'downloading update'
        : 'downloading unsigned test build (you asked for it explicitly; Windows SmartScreen will warn)',
    });
    try {
      await this.opts.updater.downloadUpdate();
      if (this.statusNow() === 'downloading')
        this.update({ status: 'downloaded', message: 'update downloaded; installing' });
      this.opts.updater.quitAndInstall(false, true);
    } catch (err) {
      this.onError(err);
    }
    return this.state();
  }

  dispose(): void {
    this.emitter.removeAll();
    this.opts.updater.removeAllListeners?.();
  }

  private wire(): void {
    const u = this.opts.updater;
    u.on('checking-for-update', () => this.update({ status: 'checking', message: 'checking for updates' }));
    u.on('update-available', (info) => this.onAvailable(info));
    u.on('update-not-available', () => this.update({ status: 'up-to-date', message: 'you are on the latest version' }));
    u.on('download-progress', (p) => {
      this.progress = p;
      this.update({ status: 'downloading', message: `downloading ${Math.round(p.percent)}%` });
    });
    u.on('update-downloaded', (info) =>
      this.update({
        status: 'downloaded',
        availableVersion: info.version,
        message: this.decision.autoInstallOnAppQuit
          ? 'update downloaded; it installs when you quit, or now on request'
          : 'update downloaded; install when ready',
      }),
    );
    u.on('error', (err) => this.onError(err));
  }

  private onAvailable(info: UpdateInfoLike): void {
    const verdict = isAcceptableUpdate(this.opts.currentVersion, info.version, this.decision);
    if (!verdict.ok) {
      this.logger.info('update offered but rejected by policy', {
        offered: info.version,
        reason: verdict.reason ?? '',
      });
      this.update({ status: 'up-to-date', message: verdict.reason ?? 'offered update rejected by policy' });
      return;
    }
    const message = this.decision.autoDownload
      ? `update ${info.version} available; downloading in the background`
      : this.current.signed
        ? `update ${info.version} available; install when ready`
        : `update ${info.version} available (unsigned build: install is manual)`;
    this.update({
      status: this.decision.autoDownload ? 'downloading' : 'available',
      availableVersion: info.version,
      message,
    });
  }

  private onError(err: unknown): void {
    const raw = err instanceof Error ? err.message : String(err);
    const message = redactText(raw).slice(0, 200);
    this.logger.warn('updater error', { error: message });
    this.update({ status: 'error', message: `update check failed: ${message}` });
  }

  /** Method (not property access) so TypeScript does not keep a stale narrowing across `update()` calls. */
  private statusNow(): UpdaterState['status'] {
    return this.current.status;
  }

  private update(patch: Partial<UpdaterState>): void {
    const next: UpdaterState = { ...this.current, ...patch };
    if (patch.status && patch.status !== 'downloading') this.progress = undefined;
    this.current = next;
    this.emitter.emit('change', { ...next });
  }

  /** Last download progress, for the settings panel (not part of UpdaterState). */
  downloadProgress(): ProgressInfoLike | undefined {
    return this.progress ? { ...this.progress } : undefined;
  }
}

/** An AutoUpdaterLike that never finds updates — for development runs and tests where the policy is disabled anyway. */
export function createInertAutoUpdater(): AutoUpdaterLike {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    async checkForUpdates() {
      return null;
    },
    async downloadUpdate() {
      return [];
    },
    quitAndInstall() {
      /* nothing to install */
    },
    on() {
      return undefined;
    },
    removeAllListeners() {
      return undefined;
    },
  };
}
