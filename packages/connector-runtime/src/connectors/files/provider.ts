import { observationId, type Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  type ProviderContext,
  type ProviderHealth,
  type ProviderQuery,
  type ProviderSettingDefinition,
} from '@worldview/provider-sdk';
import {
  compileMapping,
  definitionToManifest,
  mapRecords,
  type CompiledMapping,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
} from '@worldview/connector-sdk';
import {
  DEFAULT_FILE_INTERVAL_SECONDS,
  DEFAULT_FILE_MAX_BYTES,
  MIN_FILE_INTERVAL_SECONDS,
  fileSpecOf,
  fileSpecSchema,
  type FileFormat,
  type FileSourceManifest,
  type FileSpec,
  type GrantedFileStat,
} from './contract.js';
import { checkRelativePath } from './path-policy.js';
import { decodeText, readFileRecords, withFileDefaults } from './formats.js';

/**
 * What the file connectors share: the manifest a file source amounts to, the checks every
 * file definition passes, and a polling provider that looks at the file's modification time
 * on each poll and reads and maps it only when it changed.
 *
 * The provider never touches the file system. It reads through a port — by default the
 * folder the host grants it (amendment A2) — so that nothing but the host decides what may
 * be read, and so tests can put a fixture behind the same port.
 */
export const FOLDER_SETTING = 'folder';

export const FOLDER_SETTING_DEFINITION: ProviderSettingDefinition = {
  key: FOLDER_SETTING,
  label: 'Folder',
  kind: 'string',
  description:
    "The folder WORLDVIEW may read this source's file from. Nothing outside it is read, and links that lead out of it are refused.",
  placeholder: 'C:\\Users\\you\\Documents\\GIS',
};

/** Records whose own data carries no time are dated by the file (`file-time`), not the poll. */
export const FILE_TIME_FLAG = 'file-time';

/** How a provider sees its file: two calls, both answered by the host. */
export interface FileSource {
  stat(signal: AbortSignal): Promise<GrantedFileStat>;
  load(maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
}

export function unsupportedSource(message: string): FileSource {
  const fail = async (): Promise<never> => {
    throw new ProviderError('UNSUPPORTED', message, { retryable: false });
  };
  return { stat: fail, load: fail };
}

/** The manifest of a file source: filesystem transport, no hosts, the folder setting the host grants. */
export function fileSourceManifest(
  d: ConnectorProviderDefinition,
  spec: FileSpec,
  connectorName: string,
  timeoutMs: number,
): FileSourceManifest {
  const base = definitionToManifest(d, connectorName);
  const intervalSeconds = Math.max(MIN_FILE_INTERVAL_SECONDS, spec.intervalSeconds ?? DEFAULT_FILE_INTERVAL_SECONDS);
  const settings = [...(base.settings ?? [])];
  if (!settings.some((s) => s.key === FOLDER_SETTING)) settings.unshift(FOLDER_SETTING_DEFINITION);
  return {
    ...base,
    transport: 'filesystem',
    allowedHosts: [],
    capabilities: { live: false, historical: false, offline: true, boundsQuery: false },
    refreshPolicy: {
      ...base.refreshPolicy,
      intervalMs: intervalSeconds * 1000,
      minIntervalMs: MIN_FILE_INTERVAL_SECONDS * 1000,
      timeoutMs,
      maxRetries: 0,
      // One look at the file per poll; twice the cadence leaves room for an explicit refresh.
      maxRequestsPerMinute: Math.max(2, Math.ceil(60 / intervalSeconds) * 2),
      staleWhileErrorMs: 0,
    },
    settings,
    grantedFolderSetting: FOLDER_SETTING,
  };
}

/** Checks every file definition passes, before the connector's own. */
export function validateFileDefinition(
  d: ConnectorProviderDefinition,
  connectorName: string,
): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const spec = fileSpecOf(d);
  if (!spec) {
    // Until amendment A1 lands the frozen schema drops "file" before any connector sees it, so a
    // correct definition is refused here too; the message says so rather than blaming the file.
    errors.push(
      `a ${connectorName} source needs a "file" block naming the file inside the granted folder, e.g. { "path": "tracks/run.gpx" }` +
        ' (a build whose definition schema does not keep "file" yet — ADR-013 amendment A1, docs/connectors/files.md — refuses every file definition here)',
    );
    return { ok: false, errors, warnings };
  }
  const parsed = fileSpecSchema.parse(spec);
  if (!parsed.ok)
    for (const issue of parsed.issues) errors.push(`file${issue.path ? `.${issue.path}` : ''}: ${issue.message}`);
  const path = checkRelativePath(spec.path);
  if (!path.ok) errors.push(`file.path: ${path.reason}`);
  if (d.endpoint) errors.push(`endpoint is not used: a ${connectorName} source reads a file, not a URL`);
  if (d.websocket) errors.push(`websocket is not used: a ${connectorName} source reads a file`);
  if (d.boundsQuery) errors.push('boundsQuery does not apply to a file: the whole file is read');
  if (d.pagination && d.pagination.strategy !== 'none') warnings.push('pagination is ignored: a file is read whole');
  if (d.credentials && Object.keys(d.credentials).length)
    warnings.push('credentials are ignored: a file in a granted folder needs none');
  const folder = d.settings?.find((s) => s.key === FOLDER_SETTING);
  if (folder && folder.kind !== 'string') errors.push(`the "${FOLDER_SETTING}" setting must be a string (the folder)`);
  if (!d.freshness) warnings.push("freshness is unset: the object type's default applies");
  return { ok: errors.length === 0, errors, warnings };
}

interface CachedRead {
  key: string;
  observations: Observation[];
  mtimeMs: number;
}

export abstract class FileBackedProvider extends PollingProvider {
  readonly manifest: FileSourceManifest;
  protected readonly spec: FileSpec;
  protected readonly path: string;
  protected readonly effective: ConnectorProviderDefinition;
  private readonly mapping: CompiledMapping;
  protected source!: FileSource;
  private cache: CachedRead | undefined;
  private lastLookAt = Number.NEGATIVE_INFINITY;
  private lastRejected = 0;
  private lastFiltered = 0;
  private lastModified: number | undefined;

  constructor(
    readonly definition: ConnectorProviderDefinition,
    connectorName: string,
    protected readonly format: FileFormat | 'json',
    timeoutMs: number,
  ) {
    super();
    const spec = fileSpecOf(definition);
    if (!spec) throw new Error(`${definition.id}: the ${connectorName} connector needs a file block`);
    const path = checkRelativePath(spec.path);
    if (!path.ok) throw new Error(`${definition.id}: ${path.reason}`);
    this.spec = spec;
    this.path = path.path;
    this.effective = withFileDefaults(definition, format);
    this.mapping = compileMapping(this.effective.mapping);
    this.manifest = fileSourceManifest(definition, spec, connectorName, timeoutMs);
  }

  /** The port this provider reads through; decided once the context is known. */
  protected abstract createSource(context: ProviderContext): FileSource;

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.source = this.createSource(context);
  }

  protected get maxBytes(): number {
    return this.spec.maxBytes ?? DEFAULT_FILE_MAX_BYTES;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    const { signal } = request;
    const cancelled = () => {
      if (signal.aborted) throw new ProviderError('CANCELLED', 'cancelled');
    };
    cancelled();
    const now = this.context.clock.now();
    // Never look more often than the minimum interval, whoever asks.
    if (this.cache && now - this.lastLookAt < MIN_FILE_INTERVAL_SECONDS * 1000)
      return { observations: this.cache.observations, cacheAgeMs: now - this.lastLookAt };
    try {
      return await this.look(signal, now, cancelled);
    } catch (err) {
      // What the file said before no longer stands once looking at it fails (gone, too large, unreadable).
      if (!(err instanceof ProviderError && err.code === 'CANCELLED')) this.cache = undefined;
      throw err;
    }
  }

  private async look(
    signal: AbortSignal,
    now: number,
    cancelled: () => void,
  ): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    const before = await this.source.stat(signal);
    this.lastLookAt = now;
    this.lastModified = before.mtimeMs;
    cancelled();
    const key = `${before.size}:${before.mtimeMs}`;
    if (this.cache && this.cache.key === key) return { observations: this.cache.observations, cacheAgeMs: 0 };
    if (before.size > this.maxBytes)
      throw new ProviderError('TOO_LARGE', `${this.path} is ${before.size} bytes; the limit is ${this.maxBytes}`, {
        retryable: false,
      });
    const bytes = await this.source.load(this.maxBytes, signal);
    cancelled();
    const after = await this.source.stat(signal);
    const settled = after.size === before.size && after.mtimeMs === before.mtimeMs;
    const decoded = decodeText(bytes, this.format === 'gpx' || this.format === 'kml');
    if (decoded.fallback)
      this.context.logger.warn('file is not UTF-8; read as Windows-1252', { file: this.path, bytes: bytes.length });
    const read = readFileRecords(decoded.text, this.format, this.effective, this.spec);
    if ('malformed' in read) {
      if (!settled)
        throw new ProviderError('MALFORMED', `${this.path} changed while it was read; the next poll reads it again`, {
          retryable: true,
        });
      throw new ProviderError('MALFORMED', `${this.definition.id}: ${this.path}: ${read.malformed}`, {
        retryable: false,
      });
    }
    for (const note of read.notes) this.context.logger.info('file note', { file: this.path, note });
    const receivedAt = new Date(now).toISOString();
    const mapped = mapRecords(read.records, {
      manifest: this.manifest,
      definition: this.effective,
      mapping: this.mapping,
      receivedAt,
      origin: 'live',
      sourceRef: `file:${this.path}`,
      hash: (s) => this.context.hash.sha256Hex(s),
    });
    const rejected = [
      ...read.skipped.map((s) => `${s.id}: ${s.reason}`),
      ...mapped.rejected.map((r) => `record ${r.index}: ${r.reason}`),
    ];
    this.lastRejected = rejected.length;
    this.lastFiltered = mapped.filtered;
    if (rejected.length)
      this.context.logger.warn('rejected records', {
        file: this.path,
        count: rejected.length,
        sample: rejected.slice(0, 3),
      });
    const total = mapped.total + read.skipped.length;
    if (total > 0 && mapped.observations.length === 0 && mapped.filtered === 0)
      throw new ProviderError(
        'MALFORMED',
        `${this.path}: ${total} record(s), none usable${rejected[0] ? ` (${rejected[0].slice(0, 160)})` : ''}`,
        { retryable: false },
      );
    const observations = datedByFile(mapped.observations, Math.min(before.mtimeMs, now));
    // A file that changed while it was read is served, but not remembered: the next poll reads it again.
    this.cache = settled ? { key, observations, mtimeMs: before.mtimeMs } : undefined;
    this.context.logger.debug('file read', {
      file: this.path,
      format: read.format,
      encoding: decoded.encoding,
      records: total,
      observations: observations.length,
      filtered: mapped.filtered,
      rejected: rejected.length,
    });
    return { observations, cacheAgeMs: 0 };
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (!h.message && this.lastRejected > 0)
      h.message = `${this.lastRejected} record(s) in ${this.path} rejected on the last read${this.lastFiltered ? `; ${this.lastFiltered} filtered out` : ''}`;
    else if (!h.message && this.lastModified !== undefined)
      h.message = `${this.path}, modified ${new Date(this.lastModified).toISOString()}`;
    return h;
  }
}

/**
 * Records that carry no time of their own are dated by the file's modification time — the
 * moment the file last said so — rather than by the poll, and flagged `file-time`. The id
 * follows the time (world-model `observationId`), so an unchanged file yields the same
 * observations on every poll.
 */
export function datedByFile(observations: Observation[], mtimeMs: number): Observation[] {
  const fileTime = new Date(mtimeMs).toISOString();
  return observations.map((o) => {
    const flags = o.quality.flags;
    if (!flags?.includes('fetch-time')) return o;
    return {
      ...o,
      id: observationId(o.providerId, o.externalId ?? o.id, fileTime),
      observedAt: fileTime,
      quality: { ...o.quality, flags: flags.map((f) => (f === 'fetch-time' ? FILE_TIME_FLAG : f)) },
    };
  });
}
