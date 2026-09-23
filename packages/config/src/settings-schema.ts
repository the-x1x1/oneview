import { s, type Schema } from '@worldview/world-model';
import type { AppSettings } from '@worldview/ipc-contract';

/**
 * AppSettings defaults and the runtime schema every settings document must satisfy
 * (directive §140: everything crossing a trust boundary is validated; settings.json
 * is user-editable on disk and therefore untrusted).
 */
const defaults: AppSettings = {
  renderMode: 'AUTO',
  firstRunCompleted: false,
  basemapId: 'natural-earth',
  terrainId: 'ellipsoid',
  activeLensId: 'overview',
  reducedMotion: false,
  textScale: 1,
  updater: { automatic: false, prerelease: false },
  cameras: { go2rtcPath: '' },
  demoMode: false,
  privacy: { telemetry: false },
  providers: {},
  hiddenLayers: [],
  tileCache: { maxMB: 2048, preloadWorld: false },
  history: { maxMB: 10_240 },
  reference: { borders: true, labels: true },
};
export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze(defaults);

const idString = s.string({ min: 1, max: 128, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ });

/**
 * A path to a binary the runtime will spawn, so it is validated rather than trusted:
 * empty (not configured) or absolute. A relative path would be resolved against the
 * working directory and could pick up an attacker-planted binary; PATH lookup is never
 * allowed for the same reason (ADR-009).
 */
const binaryPath = s.refine(s.string({ max: 512 }), (value) => {
  if (value === '') return undefined;
  if (value.includes('\0')) return 'must not contain a null byte';
  const absolute = value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
  return absolute ? undefined : 'must be an absolute path';
});

const settingsShape = {
  renderMode: s.enum(['2D', '3D', 'AUTO'] as const),
  firstRunCompleted: s.boolean(),
  basemapId: idString,
  terrainId: idString,
  activeLensId: idString,
  reducedMotion: s.boolean(),
  textScale: s.number({ min: 0.75, max: 2 }),
  updater: s.object({ automatic: s.boolean(), prerelease: s.boolean() }),
  cameras: s.object({ go2rtcPath: binaryPath }),
  demoMode: s.boolean(),
  privacy: s.object({ telemetry: s.literal(false) }),
  providers: s.record(s.object({ enabled: s.boolean() }), { keyPattern: /^[a-z0-9][a-z0-9-]*$/, max: 256 }),
  hiddenLayers: s.array(idString, { max: 64 }),
  // 64 MB to 1 TB: below that the cache holds less than one screen of every zoom level.
  tileCache: s.object({ maxMB: s.number({ min: 64, max: 1_048_576, integer: true }), preloadWorld: s.boolean() }),
  // 1 GB to 1 TB. Over the cap the oldest movement history goes first (history-store `enforceSizeCap`).
  history: s.object({ maxMB: s.number({ min: 1024, max: 1_048_576, integer: true }) }),
  reference: s.object({ borders: s.boolean(), labels: s.boolean() }),
};

export const appSettingsSchema: Schema<AppSettings> = s.object(settingsShape) as unknown as Schema<AppSettings>;

/** Every key optional — the shape of a `settings.set` request / `SettingsStore.patch()` argument. */
export const appSettingsPatchSchema: Schema<Partial<AppSettings>> = s.object(
  {
    renderMode: s.optional(settingsShape.renderMode),
    firstRunCompleted: s.optional(settingsShape.firstRunCompleted),
    basemapId: s.optional(settingsShape.basemapId),
    terrainId: s.optional(settingsShape.terrainId),
    activeLensId: s.optional(settingsShape.activeLensId),
    reducedMotion: s.optional(settingsShape.reducedMotion),
    textScale: s.optional(settingsShape.textScale),
    updater: s.optional(settingsShape.updater),
    cameras: s.optional(settingsShape.cameras),
    demoMode: s.optional(settingsShape.demoMode),
    privacy: s.optional(settingsShape.privacy),
    providers: s.optional(settingsShape.providers),
    hiddenLayers: s.optional(settingsShape.hiddenLayers),
    tileCache: s.optional(settingsShape.tileCache),
    history: s.optional(settingsShape.history),
    reference: s.optional(settingsShape.reference),
  },
  { strict: true },
) as unknown as Schema<Partial<AppSettings>>;

/** Deep copy so callers can never mutate the store's state through a returned reference. */
export function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    updater: { ...settings.updater },
    cameras: { ...settings.cameras },
    privacy: { ...settings.privacy },
    providers: Object.fromEntries(Object.entries(settings.providers).map(([k, v]) => [k, { ...v }])),
    hiddenLayers: [...settings.hiddenLayers],
    tileCache: { ...settings.tileCache },
    history: { ...settings.history },
    reference: { ...settings.reference },
  };
}

/**
 * Merge a patch into current settings. Top-level keys replace; `providers` merges per
 * provider id so enabling one provider never drops the others.
 */
export function applySettingsPatch(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const next = cloneSettings(current);
  if (patch.renderMode !== undefined) next.renderMode = patch.renderMode;
  if (patch.firstRunCompleted !== undefined) next.firstRunCompleted = patch.firstRunCompleted;
  if (patch.basemapId !== undefined) next.basemapId = patch.basemapId;
  if (patch.terrainId !== undefined) next.terrainId = patch.terrainId;
  if (patch.activeLensId !== undefined) next.activeLensId = patch.activeLensId;
  if (patch.reducedMotion !== undefined) next.reducedMotion = patch.reducedMotion;
  if (patch.textScale !== undefined) next.textScale = patch.textScale;
  if (patch.updater !== undefined) next.updater = { ...patch.updater };
  if (patch.cameras !== undefined) next.cameras = { ...patch.cameras };
  if (patch.demoMode !== undefined) next.demoMode = patch.demoMode;
  if (patch.privacy !== undefined) next.privacy = { ...patch.privacy };
  if (patch.hiddenLayers !== undefined) next.hiddenLayers = [...new Set(patch.hiddenLayers)];
  if (patch.tileCache !== undefined) next.tileCache = { ...patch.tileCache };
  if (patch.history !== undefined) next.history = { ...patch.history };
  if (patch.reference !== undefined) next.reference = { ...patch.reference };
  if (patch.providers !== undefined) {
    for (const [id, cfg] of Object.entries(patch.providers)) next.providers[id] = { ...cfg };
  }
  return next;
}
