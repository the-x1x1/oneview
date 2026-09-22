import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@worldview/core/node';
import { silentLogger, type Logger } from '@worldview/core';

interface Envelope<T> {
  version: 1;
  items: T[];
}

/**
 * A small, atomic, validated list document — collections.json, watchzones.json,
 * lenses.json. Corrupt files are preserved next to the original and replaced with an
 * empty list (same contract the startup validator documents), never silently dropped.
 */
export class JsonDocStore<T extends { id: string }> {
  private items: T[] | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly validate: (value: unknown) => T | undefined,
    private readonly log: Logger = silentLogger,
  ) {}

  async load(): Promise<T[]> {
    if (this.items) return this.items;
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      this.items = [];
      return this.items;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      await this.preserveCorrupt('not valid JSON');
      this.items = [];
      return this.items;
    }
    const envelope = parsed as Partial<Envelope<unknown>>;
    const list = Array.isArray(envelope?.items) ? envelope.items : Array.isArray(parsed) ? parsed : undefined;
    if (!list) {
      await this.preserveCorrupt('not a { version, items } document');
      this.items = [];
      return this.items;
    }
    const valid: T[] = [];
    let dropped = 0;
    for (const entry of list) {
      const v = this.validate(entry);
      if (v) valid.push(v);
      else dropped++;
    }
    if (dropped)
      this.log.warn('user document: entries dropped as invalid', { file: path.basename(this.file), dropped });
    this.items = valid;
    return this.items;
  }

  async list(): Promise<T[]> {
    return structuredClone(await this.load());
  }

  async save(item: T): Promise<T[]> {
    const items = await this.load();
    const index = items.findIndex((i) => i.id === item.id);
    if (index >= 0) items[index] = item;
    else items.push(item);
    await this.persist();
    return structuredClone(items);
  }

  async remove(id: string): Promise<T[]> {
    const items = await this.load();
    const next = items.filter((i) => i.id !== id);
    this.items = next;
    await this.persist();
    return structuredClone(next);
  }

  /**
   * Replace the whole list in one write. Used where the authoritative copy lives
   * elsewhere in memory (the camera gateways' registries) and this file is a mirror of
   * it, so a per-item save would leave removed entries behind.
   */
  async replaceAll(items: T[]): Promise<T[]> {
    await this.load();
    this.items = structuredClone(items);
    await this.persist();
    return structuredClone(this.items);
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.load()).find((i) => i.id === id);
  }

  /** Serialized writes: a save never races another save on the same file. */
  private async persist(): Promise<void> {
    const snapshot: Envelope<T> = { version: 1, items: this.items ?? [] };
    this.writing = this.writing
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, `${JSON.stringify(snapshot, null, 2)}\n`);
      })
      .catch((err: unknown) => {
        this.log.error('user document write failed', {
          file: path.basename(this.file),
          error: err instanceof Error ? err.message : String(err),
        });
      });
    await this.writing;
  }

  private async preserveCorrupt(reason: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preserved = `${this.file}.corrupt-${stamp}`;
    try {
      await fs.rename(this.file, preserved);
    } catch {
      /* best effort */
    }
    this.log.warn('user document unreadable; preserved and replaced with an empty list', {
      file: path.basename(this.file),
      reason,
      preserved: path.basename(preserved),
    });
  }
}
