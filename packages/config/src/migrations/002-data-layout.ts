import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '@worldview/core/node';
import { ensureDataDirs } from '../data-dirs.js';
import type { Migration } from './runner.js';

/**
 * 002 — userData directory layout v1.
 *
 * Creates history/, worldpacks/, cache/, logs/ and seeds the three user documents
 * (collections, watch zones, lenses) as empty versioned lists so later code can
 * treat a missing file as corruption rather than as "first run".
 */
export const EMPTY_USER_LIST = { version: 1, items: [] as never[] };

export const dataLayoutMigration: Migration = {
  version: 2,
  name: 'data-directory-layout-v1',
  async up(ctx) {
    await ensureDataDirs(ctx.dirs);
    for (const file of [ctx.dirs.collectionsFile, ctx.dirs.watchzonesFile, ctx.dirs.lensesFile]) {
      if (!(await exists(file))) await writeFileAtomic(file, JSON.stringify(EMPTY_USER_LIST, null, 2) + '\n');
    }
  },
};

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}
