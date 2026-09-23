import {
  s,
  boundsSchema,
  positionSchema,
  regionSchema,
  timeRangeSchema,
  worldQuerySchema,
  type Schema,
} from '@worldview/world-model';
import type {
  RequestChannel,
  RequestOf,
  Collection,
  WatchZone,
  CameraSourceInput,
  WorldSubscription,
  TimelineState,
} from '@worldview/ipc-contract';
import type { LensDefinition, RenderingRule } from '@worldview/render-core';
import { appSettingsPatchSchema } from '@worldview/config';

/**
 * One request schema per IPC channel. The mapped type makes the catalogue
 * exhaustive: adding a channel to the contract without a schema here is a compile
 * error, and the router refuses any channel that is not in this map at runtime.
 *
 * Limits are deliberate: every string has a max length, every array a max size, so
 * a compromised renderer cannot make main allocate unboundedly.
 */
export type RequestSchemas = { readonly [C in RequestChannel]: Schema<RequestOf<C>> };

/** `void` requests: the renderer sends `undefined`; `null` is tolerated for JSON transports. */
const voidSchema: Schema<void> = {
  kind: 'void',
  parse: (value, path = '') =>
    value === undefined || value === null
      ? { ok: true, value: undefined }
      : { ok: false, issues: [{ path, message: 'expected no payload' }] },
};

const id = s.string({ min: 1, max: 512 });
const shortId = s.string({ min: 1, max: 128, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/ });
const providerId = s.string({ min: 1, max: 64, pattern: /^[a-z0-9][a-z0-9-]*$/ });
const iso = s.string({ min: 20, max: 40, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/ });
const objectType = s.string({ min: 1, max: 64, pattern: /^[a-z0-9][a-z0-9-]*$/ });
const severity = s.enum(['INFO', 'MINOR', 'MODERATE', 'SEVERE', 'EXTREME'] as const);
const credentialKey = s.string({ min: 1, max: 128, pattern: /^[a-z0-9][a-z0-9._-]*$/i });
const httpsUrl = s.refine(s.string({ min: 8, max: 2048 }), (v) => {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'invalid url';
  }
  if (u.protocol !== 'https:') return 'only https urls may be opened';
  if (u.username || u.password) return 'credentials in url are not allowed';
  return undefined;
});
const cameraUrl = s.refine(s.string({ min: 8, max: 2048 }), (v) => {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'invalid url';
  }
  return ['rtsp:', 'rtsps:', 'http:', 'https:'].includes(u.protocol)
    ? undefined
    : 'camera urls must be rtsp(s):// or http(s)://';
});

const lodMode = s.enum(['hidden', 'density', 'points', 'markers', 'icons'] as const);
const lodBand = s.object({ global: lodMode, continental: lodMode, regional: lodMode, local: lodMode });
const renderingRuleSchema = s.object({
  objectTypes: s.array(objectType, { max: 64 }),
  lod: lodBand,
  styleClass: s.string({ min: 1, max: 64, pattern: /^[a-z0-9][a-z0-9-]*$/ }),
  icon: s.optional(s.string({ min: 1, max: 64, pattern: /^[a-z0-9][a-z0-9-]*$/ })),
  sizeBy: s.optional(
    s.object({
      property: s.string({ min: 1, max: 128 }),
      min: s.number(),
      max: s.number(),
      scale: s.tuple([s.number({ min: 0, max: 512 }), s.number({ min: 0, max: 512 })]),
    }),
  ),
  colorBy: s.optional(
    s.object({
      property: s.string({ min: 1, max: 128 }),
      bands: s.array(s.object({ upTo: s.number(), suffix: s.string({ min: 1, max: 32 }) }), { max: 32 }),
    }),
  ),
  basePriority: s.number({ min: 0, max: 1000 }),
  densityCellDeg: s.optional(
    s.object({
      global: s.optional(s.number({ min: 0.01, max: 90 })),
      continental: s.optional(s.number({ min: 0.01, max: 90 })),
      regional: s.optional(s.number({ min: 0.01, max: 90 })),
      local: s.optional(s.number({ min: 0.01, max: 90 })),
    }),
  ),
  clusterPx: s.optional(s.number({ min: 0, max: 512 })),
}) as unknown as Schema<RenderingRule>;

export const lensDefinitionSchema = s.object(
  {
    id: shortId,
    name: s.string({ min: 1, max: 100 }),
    description: s.optional(s.string({ max: 500 })),
    objectTypes: s.array(objectType, { max: 64 }),
    eventTypes: s.array(objectType, { max: 64 }),
    providerPreferences: s.optional(s.array(providerId, { max: 64 })),
    renderingRules: s.array(renderingRuleSchema, { max: 64 }),
    visiblePanels: s.array(s.string({ min: 1, max: 32 }), { max: 16 }),
    builtIn: s.optional(s.boolean()),
  },
  { strict: true },
) as unknown as Schema<LensDefinition>;

const collectionItemSchema = s.object(
  {
    id: shortId,
    kind: s.enum(['location', 'object', 'event', 'watchzone', 'note', 'lens'] as const),
    title: s.string({ min: 1, max: 200 }),
    createdAt: iso,
    updatedAt: iso,
    position: s.optional(positionSchema),
    objectId: s.optional(id),
    eventId: s.optional(id),
    watchZoneId: s.optional(shortId),
    lensId: s.optional(shortId),
    note: s.optional(s.string({ max: 10_000 })),
    tags: s.optional(s.array(s.string({ min: 1, max: 64 }), { max: 32 })),
  },
  { strict: true },
);

export const collectionSchema = s.object(
  {
    id: shortId,
    name: s.string({ min: 1, max: 200 }),
    createdAt: iso,
    updatedAt: iso,
    items: s.array(collectionItemSchema, { max: 10_000 }),
  },
  { strict: true },
) as unknown as Schema<Collection>;

export const watchZoneSchema = s.object(
  {
    id: shortId,
    name: s.string({ min: 1, max: 200 }),
    geometry: regionSchema,
    eventTypes: s.array(objectType, { max: 64 }),
    minimumSeverity: s.optional(severity),
    notifications: s.object({ inApp: s.boolean(), desktop: s.boolean() }),
    enabled: s.boolean(),
    createdAt: iso,
  },
  { strict: true },
) as unknown as Schema<WatchZone>;

const subscriptionSchema = s.object(
  {
    objectTypes: s.optional(s.array(objectType, { max: 64 })),
    bounds: s.optional(boundsSchema),
    pinnedIds: s.optional(s.array(id, { max: 1000 })),
  },
  { strict: true },
) as unknown as Schema<WorldSubscription>;

const cameraSourceSchema = s.object(
  {
    name: s.string({ min: 1, max: 200 }),
    url: cameraUrl,
    position: s.optional(positionSchema),
    headingDegrees: s.optional(s.number({ min: 0, max: 360 })),
  },
  { strict: true },
) as unknown as Schema<CameraSourceInput>;

const timelinePatchSchema = s.object(
  {
    mode: s.optional(s.enum(['LIVE', 'PAUSED', 'REPLAY', 'HISTORICAL'] as const)),
    cursor: s.optional(iso),
    speed: s.optional(s.enum([0.25, 1, 5, 20, 60] as const)),
    range: s.optional(timeRangeSchema),
  },
  { strict: true },
) as unknown as Schema<Partial<Pick<TimelineState, 'mode' | 'cursor' | 'speed' | 'range'>>>;

const objectIdRequest = s.object({ objectId: id }, { strict: true });
const eventIdRequest = s.object({ eventId: id }, { strict: true });
const idRequest = s.object({ id: shortId }, { strict: true });
const providerRequest = s.object({ providerId }, { strict: true });
const cameraIdRequest = s.object({ cameraId: shortId }, { strict: true });
const jsonSettings = s.record(s.json({ maxDepth: 8 }), { keyPattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, max: 128 });

export const REQUEST_SCHEMAS: RequestSchemas = {
  'app.info': voidSchema,
  'app.openExternal': s.object({ url: httpsUrl }, { strict: true }),
  'settings.get': voidSchema,
  'settings.set': appSettingsPatchSchema,
  'map.providers.list': voidSchema,
  'events.types.list': voidSchema,

  'world.query': worldQuerySchema,
  'world.get': objectIdRequest,
  'world.track': s.object({ objectId: id, time: s.optional(timeRangeSchema) }, { strict: true }) as Schema<
    RequestOf<'world.track'>
  >,
  'world.events': worldQuerySchema,
  'world.event': eventIdRequest,
  'world.subscribe': subscriptionSchema,
  'world.related': s.object({ objectId: s.optional(id), eventId: s.optional(id) }, { strict: true }) as Schema<
    RequestOf<'world.related'>
  >,
  'world.whatChanged': s.object({ region: regionSchema, time: timeRangeSchema }, { strict: true }) as Schema<
    RequestOf<'world.whatChanged'>
  >,
  'world.viewport': s.object({ bounds: boundsSchema, zoom: s.number({ min: 0, max: 30 }) }, { strict: true }) as Schema<
    RequestOf<'world.viewport'>
  >,

  'sources.list': voidSchema,
  'sources.manifest': providerRequest,
  'sources.setEnabled': s.object({ providerId, enabled: s.boolean() }, { strict: true }),
  'sources.refresh': providerRequest,
  'sources.connection': voidSchema,
  'sources.settings.get': providerRequest,
  'sources.settings.set': s.object({ providerId, settings: jsonSettings }, { strict: true }),

  'credentials.has': s.object({ key: credentialKey }, { strict: true }),
  'credentials.set': s.object({ key: credentialKey, value: s.string({ min: 1, max: 4096 }) }, { strict: true }),
  'credentials.delete': s.object({ key: credentialKey }, { strict: true }),

  'history.query': worldQuerySchema,
  'history.availability': s.object(
    { objectTypes: s.optional(s.array(objectType, { max: 64 })) },
    { strict: true },
  ) as Schema<RequestOf<'history.availability'>>,
  'history.usage': voidSchema,
  'diagnostics.renderer': s.object(
    {
      active: s.enum(['2D', '3D'] as const),
      webgl2: s.boolean(),
      gpu: s.optional(s.string({ max: 256 })),
      fps: s.optional(s.number({ min: 0, max: 1000 })),
    },
    { strict: true },
  ) as Schema<RequestOf<'diagnostics.renderer'>>,
  'timeline.get': voidSchema,
  'timeline.set': timelinePatchSchema,

  'search.query': s.object(
    {
      text: s.string({ max: 500 }),
      bias: s.optional(positionSchema),
      limit: s.optional(s.number({ min: 1, max: 200, integer: true })),
    },
    { strict: true },
  ) as Schema<RequestOf<'search.query'>>,
  'lenses.list': voidSchema,
  'lenses.save': lensDefinitionSchema,
  'lenses.delete': idRequest,

  'collections.list': voidSchema,
  'collections.save': collectionSchema,
  'collections.delete': idRequest,
  'collections.export': idRequest,
  'collections.import': voidSchema,

  'watchzones.list': voidSchema,
  'watchzones.save': watchZoneSchema,
  'watchzones.delete': idRequest,

  'feed.recent': s.object(
    { limit: s.optional(s.number({ min: 1, max: 500, integer: true })), minimumSeverity: s.optional(severity) },
    { strict: true },
  ) as Schema<RequestOf<'feed.recent'>>,

  'offline.status': voidSchema,
  'offline.installPack': voidSchema,
  'offline.removePack': idRequest,
  'offline.setPackEnabled': s.object({ id: shortId, enabled: s.boolean() }, { strict: true }),

  'export.objects': s.object(
    { query: worldQuerySchema, format: s.enum(['geojson', 'json', 'csv'] as const) },
    { strict: true },
  ),

  'camera.register': cameraSourceSchema,
  'camera.snapshot': cameraIdRequest,
  'camera.stream': cameraIdRequest,
  'camera.unregister': cameraIdRequest,
  'camera.list': voidSchema,

  'diagnostics.get': voidSchema,
  'diagnostics.export': voidSchema,

  'updater.state': voidSchema,
  'updater.check': voidSchema,
  'updater.install': voidSchema,

  'tiles.status': voidSchema,
  'tiles.clear': voidSchema,
  'tiles.prefetch': s.object(
    { sourceId: providerId, bounds: boundsSchema, zoom: s.number({ min: 0, max: 30 }) },
    { strict: true },
  ) as Schema<RequestOf<'tiles.prefetch'>>,
};

export function schemaFor(channel: string): Schema<unknown> | undefined {
  return Object.prototype.hasOwnProperty.call(REQUEST_SCHEMAS, channel)
    ? (REQUEST_SCHEMAS[channel as RequestChannel] as Schema<unknown>)
    : undefined;
}
