/** Node-only helpers (main process, tools): atomic file writes, rotating file log sink, sha256. */
import { createHash } from 'node:crypto';
import { promises as fs, existsSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { LogRecord, LogSink } from './logger.js';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Atomic write: write to a temp file in the same directory, fsync, then rename over the
 * target. A crash mid-write never leaves a truncated settings/collections file.
 */
export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, target);
}

export async function readJsonFile<T = unknown>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Size-rotating JSON-lines log sink: app.log, app.log.1 … app.log.N. */
export class RotatingFileSink implements LogSink {
  constructor(private readonly file: string, private readonly opts: { maxBytes?: number; keep?: number } = {}) {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  write(record: LogRecord): void {
    const line = JSON.stringify(record) + '\n';
    try {
      if (existsSync(this.file) && statSync(this.file).size + line.length > (this.opts.maxBytes ?? 5 * 1024 * 1024)) this.rotate();
      appendFileSync(this.file, line);
    } catch { /* never throw from a log sink */ }
  }
  private rotate(): void {
    const keep = this.opts.keep ?? 3;
    const last = `${this.file}.${keep}`;
    if (existsSync(last)) unlinkSync(last);
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
  }
}
