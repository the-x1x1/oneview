/**
 * Declaration shim for `electron` — used ONLY when the real package is not installed
 * (tools/dev/typecheck.mjs maps it in and records that in evidence). It declares the
 * documented Electron ≥ 33 surface that apps/desktop/src/{main,preload} use:
 *
 *   app (single-instance lock, whenReady, paths, packaged flag, lifecycle events)
 *   BrowserWindow + webContents (window-open handler, navigation events, send)
 *   session.defaultSession (webRequest.onHeadersReceived for CSP, permission handlers)
 *   ipcMain.handle / ipcRenderer.invoke+on / contextBridge.exposeInMainWorld
 *   safeStorage, shell.openExternal, dialog.show{Open,Save}Dialog, Notification,
 *   net.isOnline, Menu.setApplicationMenu, powerMonitor (not used), nativeTheme
 *
 * Nothing here is `any`: the shapes follow the Electron API documentation.
 */
export type PathName =
  | 'home'
  | 'appData'
  | 'userData'
  | 'sessionData'
  | 'temp'
  | 'exe'
  | 'module'
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'
  | 'recent'
  | 'logs'
  | 'crashDumps';

export interface Event {
  preventDefault(): void;
  readonly defaultPrevented: boolean;
}

export interface RenderProcessGoneDetails {
  reason: 'clean-exit' | 'abnormal-exit' | 'killed' | 'crashed' | 'oom' | 'launch-failed' | 'integrity-failure';
  exitCode: number;
}
export interface Details {
  readonly reason: string;
}

export interface App {
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean;
  releaseSingleInstanceLock(): void;
  whenReady(): Promise<void>;
  quit(): void;
  exit(exitCode?: number): void;
  getPath(name: PathName): string;
  setPath(name: PathName, path: string): void;
  getVersion(): string;
  getName(): string;
  getAppPath(): string;
  setAppUserModelId(id: string): void;
  readonly isPackaged: boolean;
  enableSandbox(): void;
  on(
    event: 'second-instance',
    listener: (event: Event, argv: string[], workingDirectory: string, additionalData: unknown) => void,
  ): this;
  on(event: 'window-all-closed', listener: () => void): this;
  on(event: 'activate', listener: (event: Event, hasVisibleWindows: boolean) => void): this;
  on(event: 'before-quit', listener: (event: Event) => void): this;
  on(event: 'will-quit', listener: (event: Event) => void): this;
  on(event: 'web-contents-created', listener: (event: Event, contents: WebContents) => void): this;
  on(
    event: 'render-process-gone',
    listener: (event: Event, webContents: WebContents, details: RenderProcessGoneDetails) => void,
  ): this;
  on(
    event: 'child-process-gone',
    listener: (event: Event, details: Details & { type: string; name?: string; exitCode: number }) => void,
  ): this;
  once(event: 'ready', listener: () => void): this;
}

export interface WebPreferences {
  preload?: string;
  contextIsolation?: boolean;
  nodeIntegration?: boolean;
  nodeIntegrationInWorker?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  sandbox?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  webviewTag?: boolean;
  navigateOnDragDrop?: boolean;
  spellcheck?: boolean;
  devTools?: boolean;
  enableWebSQL?: boolean;
  experimentalFeatures?: boolean;
  backgroundThrottling?: boolean;
  disableBlinkFeatures?: string;
}

export interface BrowserWindowConstructorOptions {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  show?: boolean;
  title?: string;
  backgroundColor?: string;
  autoHideMenuBar?: boolean;
  icon?: string;
  webPreferences?: WebPreferences;
}

export interface WindowOpenHandlerDetails {
  url: string;
  frameName: string;
  disposition: string;
  referrer?: { url: string; policy: string };
}
export type WindowOpenHandlerResponse =
  { action: 'deny' } | { action: 'allow'; overrideBrowserWindowOptions?: BrowserWindowConstructorOptions };

export interface WebFrameMain {
  readonly url: string;
  readonly origin: string;
  readonly frameToken: string;
}

export interface WebContents {
  /** Runs code in the page's main world; used by the renderer watchdog. */
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  isDestroyed(): boolean;
  readonly id: number;
  readonly session: Session;
  send(channel: string, ...args: unknown[]): void;
  getURL(): string;
  isDestroyed(): boolean;
  openDevTools(options?: { mode: 'right' | 'bottom' | 'undocked' | 'detach' }): void;
  setWindowOpenHandler(handler: (details: WindowOpenHandlerDetails) => WindowOpenHandlerResponse): void;
  on(event: 'will-navigate', listener: (event: Event, url: string) => void): this;
  on(event: 'will-redirect', listener: (event: Event, url: string) => void): this;
  on(
    event: 'will-attach-webview',
    listener: (event: Event, webPreferences: WebPreferences, params: Record<string, string>) => void,
  ): this;
  on(event: 'did-finish-load', listener: () => void): this;
  on(
    event: 'did-fail-load',
    listener: (
      event: Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => void,
  ): this;
  on(event: 'render-process-gone', listener: (event: Event, details: RenderProcessGoneDetails) => void): this;
  on(event: 'unresponsive', listener: () => void): this;
  on(event: 'preload-error', listener: (event: Event, preloadPath: string, error: Error) => void): this;
  on(
    event: 'console-message',
    listener: (event: Event, level: number, message: string, line: number, sourceId: string) => void,
  ): this;
  on(event: 'destroyed', listener: () => void): this;
}

export declare class BrowserWindow {
  constructor(options?: BrowserWindowConstructorOptions);
  static getAllWindows(): BrowserWindow[];
  static fromWebContents(webContents: WebContents): BrowserWindow | null;
  readonly id: number;
  readonly webContents: WebContents;
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string): Promise<void>;
  show(): void;
  focus(): void;
  close(): void;
  destroy(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  setMenuBarVisibility(visible: boolean): void;
  on(event: 'closed', listener: () => void): this;
  on(event: 'ready-to-show', listener: () => void): this;
  once(event: 'ready-to-show', listener: () => void): this;
}

export interface OnHeadersReceivedListenerDetails {
  url: string;
  method: string;
  resourceType: string;
  statusLine: string;
  statusCode: number;
  responseHeaders?: Record<string, string[]>;
  frame?: WebFrameMain | null;
}
export interface HeadersReceivedResponse {
  cancel?: boolean;
  responseHeaders?: Record<string, string | string[]>;
  statusLine?: string;
}

export interface WebRequest {
  onHeadersReceived(
    listener:
      | ((details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void) => void)
      | null,
  ): void;
  onHeadersReceived(
    filter: { urls: string[] },
    listener:
      | ((details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void) => void)
      | null,
  ): void;
}

export type PermissionType =
  | 'clipboard-read'
  | 'clipboard-sanitized-write'
  | 'display-capture'
  | 'fullscreen'
  | 'geolocation'
  | 'idle-detection'
  | 'media'
  | 'mediaKeySystem'
  | 'midi'
  | 'midiSysex'
  | 'notifications'
  | 'pointerLock'
  | 'keyboardLock'
  | 'openExternal'
  | 'speaker-selection'
  | 'storage-access'
  | 'top-level-storage-access'
  | 'window-management'
  | 'unknown'
  | 'fileSystem';

export interface PermissionRequestDetails {
  requestingUrl?: string;
  isMainFrame?: boolean;
  externalURL?: string;
  mediaTypes?: Array<'video' | 'audio'>;
}
export interface PermissionCheckDetails {
  embeddingOrigin?: string;
  requestingUrl?: string;
  isMainFrame?: boolean;
  mediaType?: 'video' | 'audio' | 'unknown';
}

export interface Session {
  readonly webRequest: WebRequest;
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: WebContents,
          permission: PermissionType,
          callback: (granted: boolean) => void,
          details: PermissionRequestDetails,
        ) => void)
      | null,
  ): void;
  setPermissionCheckHandler(
    handler:
      | ((
          webContents: WebContents | null,
          permission: string,
          requestingOrigin: string,
          details: PermissionCheckDetails,
        ) => boolean)
      | null,
  ): void;
  setDevicePermissionHandler(
    handler: ((details: { deviceType: 'hid' | 'serial' | 'usb'; origin: string }) => boolean) | null,
  ): void;
  setSpellCheckerEnabled(enabled: boolean): void;
  clearCache(): Promise<void>;
}

export declare const session: { readonly defaultSession: Session; fromPartition(partition: string): Session };

export interface IpcMainInvokeEvent {
  readonly sender: WebContents;
  readonly senderFrame: WebFrameMain | null;
  readonly frameId: number;
  readonly processId: number;
}

export interface IpcMain {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void;
  handleOnce(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void;
  removeHandler(channel: string): void;
  on(
    channel: string,
    listener: (
      event: {
        sender: WebContents;
        senderFrame: WebFrameMain | null;
        reply(channel: string, ...args: unknown[]): void;
      },
      ...args: unknown[]
    ) => void,
  ): this;
  removeAllListeners(channel?: string): this;
}
export declare const ipcMain: IpcMain;

export interface IpcRendererEvent {
  readonly sender: IpcRenderer;
  readonly ports: unknown[];
}
export interface IpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): this;
  once(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): this;
  removeListener(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): this;
  send(channel: string, ...args: unknown[]): void;
}
export declare const ipcRenderer: IpcRenderer;

export interface ContextBridge {
  exposeInMainWorld(apiKey: string, api: unknown): void;
  exposeInIsolatedWorld(worldId: number, apiKey: string, api: unknown): void;
}
export declare const contextBridge: ContextBridge;

export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend(): string;
  setUsePlainTextEncryption(usePlainText: boolean): void;
}
export declare const safeStorage: SafeStorage;

export interface Shell {
  openExternal(
    url: string,
    options?: { activate?: boolean; workingDirectory?: string; logUsage?: boolean },
  ): Promise<void>;
  showItemInFolder(fullPath: string): void;
  openPath(path: string): Promise<string>;
}
export declare const shell: Shell;

export interface FileFilter {
  name: string;
  extensions: string[];
}
export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: FileFilter[];
  properties?: Array<
    | 'openFile'
    | 'openDirectory'
    | 'multiSelections'
    | 'showHiddenFiles'
    | 'createDirectory'
    | 'promptToCreate'
    | 'dontAddToRecent'
  >;
  message?: string;
}
export interface OpenDialogReturnValue {
  canceled: boolean;
  filePaths: string[];
}
export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: FileFilter[];
  message?: string;
  nameFieldLabel?: string;
  showsTagField?: boolean;
  properties?: Array<
    'showHiddenFiles' | 'createDirectory' | 'treatPackageAsDirectory' | 'showOverwriteConfirmation' | 'dontAddToRecent'
  >;
}
export interface SaveDialogReturnValue {
  canceled: boolean;
  filePath: string;
}
export interface MessageBoxOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  buttons?: string[];
  defaultId?: number;
  title?: string;
  message: string;
  detail?: string;
  noLink?: boolean;
}
export interface MessageBoxReturnValue {
  response: number;
  checkboxChecked: boolean;
}

export interface Dialog {
  showOpenDialog(window: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
  showSaveDialog(window: BrowserWindow, options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
  showMessageBox(window: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  showErrorBox(title: string, content: string): void;
}
export declare const dialog: Dialog;

export interface NotificationConstructorOptions {
  title: string;
  body?: string;
  silent?: boolean;
  icon?: string;
  urgency?: 'normal' | 'critical' | 'low';
  timeoutType?: 'default' | 'never';
  toastXml?: string;
}
export declare class Notification {
  constructor(options?: NotificationConstructorOptions);
  static isSupported(): boolean;
  show(): void;
  close(): void;
  on(event: 'click', listener: (event: Event) => void): this;
  on(event: 'close', listener: (event: Event) => void): this;
}

export interface Net {
  isOnline(): boolean;
  readonly online: boolean;
  /** Real signature: fetch(input, init?) => Promise<Response>. Used by the app protocol to read bundled files. */
  fetch(input: string | Request, init?: RequestInit & { bypassCustomProtocolHandlers?: boolean }): Promise<Response>;
}

/** Privileges a custom scheme can be granted (Electron `CustomScheme.privileges`). */
export interface SchemePrivileges {
  standard?: boolean;
  secure?: boolean;
  bypassCSP?: boolean;
  allowServiceWorkers?: boolean;
  supportFetchAPI?: boolean;
  corsEnabled?: boolean;
  stream?: boolean;
  codeCache?: boolean;
}

export interface Protocol {
  /** Must be called before the app is ready; Chromium reads the registry as the network service starts. */
  registerSchemesAsPrivileged(customSchemes: Array<{ scheme: string; privileges?: SchemePrivileges }>): void;
  handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void;
  unhandle(scheme: string): void;
  isProtocolHandled(scheme: string): boolean;
}
export declare const net: Net;

export interface Menu {}
export declare const Menu: {
  setApplicationMenu(menu: Menu | null): void;
  buildFromTemplate(template: Array<Record<string, unknown>>): Menu;
};

export interface NativeTheme {
  shouldUseDarkColors: boolean;
  themeSource: 'system' | 'light' | 'dark';
}
export declare const nativeTheme: NativeTheme;

export interface CrashReporterStartOptions {
  submitURL?: string;
  uploadToServer?: boolean;
  compress?: boolean;
  ignoreSystemCrashHandler?: boolean;
  rateLimit?: boolean;
  extra?: Record<string, string>;
}
export declare const crashReporter: {
  start(options: CrashReporterStartOptions): void;
  getLastCrashReport(): { date: Date; id: string } | null;
};

export declare const app: App;

export const protocol: Protocol;
