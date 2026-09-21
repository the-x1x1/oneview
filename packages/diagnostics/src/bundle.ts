import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DiagnosticsSnapshot } from '@worldview/ipc-contract';
import type { JsonValue } from '@worldview/world-model';
import type { LogRecord } from '@worldview/core';
import { writeFileAtomic } from '@worldview/core/node';
import { redactStructure, type PathRedactionOptions } from './redact.js';

/**
 * A diagnostics bundle is a single JSON file (no archive dependency) containing the
 * redacted snapshot, startup findings and the tail of the application log. Everything
 * passes through redaction once more at export time even though the log sink already
 * redacts, because the snapshot carries paths the logger never saw.
 */
export interface DiagnosticsBundle {
  format: 'worldview/diagnostics-bundle/v1';
  exportedAt: string;
  redaction: { secrets: true; userPaths: true; homeDir: '~' };
  snapshot: DiagnosticsSnapshot;
  findings: JsonValue[];
  /** Newest last. */
  logTail: LogRecord[];
  logTailTruncated: boolean;
}

export interface ExportBundleOptions extends PathRedactionOptions {
  snapshot: DiagnosticsSnapshot;
  findings?: JsonValue[];
  /** Path to the JSON-lines log file (RotatingFileSink). Missing file → empty tail. */
  logFile?: string;
  maxLogLines?: number;
  now?: () => number;
  /** File name without directory; default worldview-diagnostics-<timestamp>.json */
  fileName?: string;
}

export const DEFAULT_LOG_TAIL_LINES = 2000;

export async function readLogTail(file: string, maxLines: number): Promise<{ records: LogRecord[]; truncated: boolean }> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return { records: [], truncated: false }; }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const truncated = lines.length > maxLines;
  const tail = truncated ? lines.slice(lines.length - maxLines) : lines;
  const records: LogRecord[] = [];
  for (const line of tail) {
    try {
      const r = JSON.parse(line) as LogRecord;
      if (r && typeof r === 'object' && typeof r.message === 'string') records.push(r);
    } catch { /* a torn last line is expected when the app is writing */ }
  }
  return { records, truncated };
}

export function buildBundle(opts: ExportBundleOptions, logTail: { records: LogRecord[]; truncated: boolean }): DiagnosticsBundle {
  const now = opts.now ?? Date.now;
  const redaction: PathRedactionOptions = { ...(opts.homeDir ? { homeDir: opts.homeDir } : {}), ...(opts.extraRoots ? { extraRoots: opts.extraRoots } : {}) };
  return {
    format: 'worldview/diagnostics-bundle/v1',
    exportedAt: new Date(now()).toISOString(),
    redaction: { secrets: true, userPaths: true, homeDir: '~' },
    snapshot: redactStructure(opts.snapshot, redaction),
    findings: redactStructure(opts.findings ?? [], redaction),
    logTail: redactStructure(logTail.records, redaction),
    logTailTruncated: logTail.truncated,
  };
}

/** Writes the bundle into `dir` and returns its path. */
export async function exportBundle(dir: string, opts: ExportBundleOptions): Promise<{ path: string; bundle: DiagnosticsBundle }> {
  const tail = opts.logFile ? await readLogTail(opts.logFile, opts.maxLogLines ?? DEFAULT_LOG_TAIL_LINES) : { records: [], truncated: false };
  const bundle = buildBundle(opts, tail);
  const stamp = bundle.exportedAt.replace(/[:.]/g, '-');
  const file = path.join(dir, opts.fileName ?? `worldview-diagnostics-${stamp}.json`);
  await writeFileAtomic(file, JSON.stringify(bundle, null, 2) + '\n');
  return { path: file, bundle };
}
