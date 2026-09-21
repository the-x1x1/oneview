import { s, type Schema } from '@worldview/world-model';
import type { AppSettings } from '@worldview/ipc-contract';

/**
 * AppSettings defaults and the runtime schema every settings document must satisfy
 * (directive §140: everything crossing a trust boundary is validated; settings.json
 * is user-editable on disk and therefore untrusted).
 */
const defaults: AppSettings = {
  renderMode: 'AUTO',
  basemapId: 'bundled-dark',
  terrainId: 'ellipsoid',
  activeLensId: 'overview',
  reducedMotion: false,
  textScale: 1,
  updater: { automatic: false, prerelease: false },
  demoMode: false,
  privacy: { telemetry: false },
  providers: {},
};
export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze(defaults);

const idString = s.string({ min: 1, max: 128, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ });

const settingsShape = {
  renderMode: s.enum(['2D', '3D', 'AUTO'] as const),
  basemapId: idString,
  terrainId: idString,
  activeLensId: idString,
  reducedMotion: s.boolean(),
  textScale: s.number({ min: 0.75, max: 2 }),
  updater: s.object({ automatic: s.boolean(), prerelease: s.boolean() }),
  demoMode: s.boolean(),
  privacy: s.object({ telemetry: s.literal(false) }),
  providers: s.record(s.object({ enabled: s.boolean() }), { keyPattern: /^[a-z0-9][a-z0-9-]*$/, max: 256 }),
};

export const appSettingsSchema: Schema<AppSettings> = s.object(settingsShape) as unknown as Schema<AppSettings>;

/** Every key optional — the shape of a `settings.set` request / `SettingsStore.patch()` argument. */
export const appSettingsPatchSchema: Schema<Partial<AppSettings>> = s.object({
  renderMode: s.optional(settingsShape.renderMode),
  basemapId: s.optional(settingsShape.basemapId),
  terrainId: s.optional(settingsShape.terrainId),
  activeLensId: s.optional(settingsShape.activeLensId),
  reducedMotion: s.optional(settingsShape.reducedMotion),
  textScale: s.optional(settingsShape.textScale),
  updater: s.optional(settingsShape.updater),
  demoMode: s.optional(settingsShape.demoMode),
  privacy: s.optional(settingsShape.privacy),
  providers: s.optional(settingsShape.providers),
}, { strict: true }) as unknown as Schema<Partial<AppSettings>>;

/** Deep copy so callers can never mutate the store's state through a returned reference. */
export function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    updater: { ...settings.updater },
    privacy: { ...settings.privacy },
    providers: Object.fromEntries(Object.entries(settings.providers).map(([k, v]) => [k, { ...v }])),
  };
}

/**
 * Merge a patch into current settings. Top-level keys replace; `providers` merges per
 * provider id so enabling one provider never drops the others.
 */
export function applySettingsPatch(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const next = cloneSettings(current);
  if (patch.renderMode !== undefined) next.renderMode = patch.renderMode;
  if (patch.basemapId !== undefined) next.basemapId = patch.basemapId;
  if (patch.terrainId !== undefined) next.terrainId = patch.terrainId;
  if (patch.activeLensId !== undefined) next.activeLensId = patch.activeLensId;
  if (patch.reducedMotion !== undefined) next.reducedMotion = patch.reducedMotion;
  if (patch.textScale !== undefined) next.textScale = patch.textScale;
  if (patch.updater !== undefined) next.updater = { ...patch.updater };
  if (patch.demoMode !== undefined) next.demoMode = patch.demoMode;
  if (patch.privacy !== undefined) next.privacy = { ...patch.privacy };
  if (patch.providers !== undefined) {
    for (const [id, cfg] of Object.entries(patch.providers)) next.providers[id] = { ...cfg };
  }
  return next;
}
