import { silentLogger, type Logger } from '@worldview/core';
import { errorMessage, isHistoryBackendUnavailable, type HistoryBackend } from './backend.js';
import { NdjsonBackend, type NdjsonBackendOptions } from './ndjson-backend.js';
import { DUCKDB_BACKEND_KIND, DuckDbParquetBackend, type DuckDbParquetBackendOptions } from './duckdb-backend.js';

export type HistoryBackendKind = 'ndjson' | typeof DUCKDB_BACKEND_KIND;

export interface CreateHistoryBackendOptions {
  dataDir: string;
  /** Preferred backend; DuckDB falls back to NDJSON when the native module cannot be loaded. */
  preferred?: HistoryBackendKind;
  logger?: Logger;
  clock?: { now(): number };
  ndjson?: Omit<NdjsonBackendOptions, 'dataDir' | 'logger' | 'clock'>;
  duckdb?: Omit<DuckDbParquetBackendOptions, 'dataDir' | 'logger' | 'clock'>;
}

export interface CreatedHistoryBackend {
  backend: HistoryBackend;
  requestedBackend: HistoryBackendKind;
  /** Present when the preferred backend was unavailable and NDJSON was used instead. */
  fallbackReason?: string;
}

/**
 * Open the preferred backend; on HistoryBackendUnavailableError (native module missing,
 * failed to load, json extension absent) open NdjsonBackend and record why, so the
 * store's diagnostics can show "requested duckdb-parquet, running ndjson: <reason>".
 * Any other error from the preferred backend is a real fault and is rethrown.
 */
export async function createHistoryBackend(opts: CreateHistoryBackendOptions): Promise<CreatedHistoryBackend> {
  const requestedBackend: HistoryBackendKind = opts.preferred ?? 'ndjson';
  const log = opts.logger ?? silentLogger;
  const common = { dataDir: opts.dataDir, ...(opts.logger ? { logger: opts.logger } : {}), ...(opts.clock ? { clock: opts.clock } : {}) };
  if (requestedBackend === DUCKDB_BACKEND_KIND) {
    const duck = new DuckDbParquetBackend({ ...common, ...(opts.duckdb ?? {}) });
    try {
      await duck.open();
      return { backend: duck, requestedBackend };
    } catch (err) {
      if (!isHistoryBackendUnavailable(err)) throw err;
      const fallbackReason = err.reason ?? errorMessage(err);
      log.warn('history: DuckDB backend unavailable, falling back to NDJSON', { reason: fallbackReason });
      const ndjson = new NdjsonBackend({ ...common, ...(opts.ndjson ?? {}) });
      await ndjson.open();
      return { backend: ndjson, requestedBackend, fallbackReason };
    }
  }
  const ndjson = new NdjsonBackend({ ...common, ...(opts.ndjson ?? {}) });
  await ndjson.open();
  return { backend: ndjson, requestedBackend };
}
