import { ProviderError } from '@worldview/provider-sdk';
import { isRecord, linkOf } from './items.js';

/**
 * Static STAC catalogues: a `catalog.json` (or `collection.json`) whose `child` links lead to
 * more catalogues and collections and whose `item` links lead to items, each a JSON file of
 * its own — how most open imagery on object storage is published. The walk also reads what
 * an API serves at the same places: a collection's `items` link (an ItemCollection, paged by
 * `rel=next`), an ItemCollection or a single item as the root.
 *
 * Bounded three ways: a depth cap (the root is depth 0; a document linked from depth d is at
 * d + 1), a document budget per walk, and the endpoint's origin — a link to anywhere else is
 * counted and not followed. Depth first, in each document's link order, items before
 * sub-catalogues, so a budget spent part-way still yields scenes rather than only folders.
 * Each URL is fetched once per walk; the same item reached by two paths is one record here
 * and one observation after the mapping's duplicate check.
 */
export const DEFAULT_MAX_DEPTH = 5;
export const MAX_DEPTH_LIMIT = 8;
export const DEFAULT_MAX_DOCUMENTS = 100;

export interface WalkItem {
  item: unknown;
  /** Where the item was read (its own file, or the item collection that held it). */
  base: string;
  /** `base` is the item's own file. */
  own?: boolean;
}

export interface WalkResult {
  items: WalkItem[];
  documents: number;
  /** Documents that could not be read or were not STAC, with why (the walk went on without them). */
  skipped: Array<{ url: string; reason: string }>;
  /** Links not followed: past the depth cap, past the document budget, or to another origin. */
  notFollowed: { depth: number; budget: number; offOrigin: number };
}

export interface WalkOptions {
  root: string;
  maxDepth: number;
  maxDocuments: number;
  signal: AbortSignal;
  /** Fetch and parse one document; throws a ProviderError (MALFORMED for a body that is not JSON). */
  fetchJson(url: string): Promise<unknown>;
}

/** Failures that end the walk: the source is unreachable, refusing us, or we were cancelled. */
const FATAL: ReadonlySet<string> = new Set([
  'AUTH',
  'RATE_LIMITED',
  'TIMEOUT',
  'NETWORK',
  'DNS',
  'OFFLINE',
  'CANCELLED',
  'HOST_NOT_ALLOWED',
  'INTERNAL',
]);

type DocKind = 'item' | 'item-collection' | 'catalog' | 'unknown';

export function stacDocKind(doc: unknown): DocKind {
  if (!isRecord(doc)) return 'unknown';
  const type = doc['type'];
  if (type === 'Feature') return 'item';
  if (type === 'FeatureCollection' && Array.isArray(doc['features'])) return 'item-collection';
  if (type === 'Catalog' || type === 'Collection') return 'catalog';
  // STAC before 1.0 had no `type` on catalogues: a stac_version and links is one.
  if (type === undefined && typeof doc['stac_version'] === 'string' && Array.isArray(doc['links'])) return 'catalog';
  return 'unknown';
}

function withoutFragment(u: URL): string {
  u.hash = '';
  return u.toString();
}

export async function walkStaticCatalog(opts: WalkOptions): Promise<WalkResult> {
  const origin = new URL(opts.root).origin;
  const result: WalkResult = {
    items: [],
    documents: 0,
    skipped: [],
    notFollowed: { depth: 0, budget: 0, offOrigin: 0 },
  };
  const visited = new Set<string>();
  const stack: Array<{ url: string; depth: number }> = [{ url: withoutFragment(new URL(opts.root)), depth: 0 }];

  /** A link from `base` at `depth`, or undefined (counted) when it is not to be followed. */
  const follow = (href: unknown, base: string, depth: number): { url: string; depth: number } | undefined => {
    if (typeof href !== 'string' || !href) return undefined;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      return undefined;
    }
    if (u.origin !== origin || u.username || u.password) {
      result.notFollowed.offOrigin++;
      return undefined;
    }
    if (depth > opts.maxDepth) {
      result.notFollowed.depth++;
      return undefined;
    }
    return { url: withoutFragment(u), depth };
  };

  while (stack.length) {
    if (opts.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled during the catalogue walk');
    const next = stack.pop()!;
    if (visited.has(next.url)) continue;
    if (result.documents >= opts.maxDocuments) {
      result.notFollowed.budget += 1 + stack.filter((s) => !visited.has(s.url)).length;
      break;
    }
    visited.add(next.url);
    result.documents++;
    let doc: unknown;
    try {
      doc = await opts.fetchJson(next.url);
    } catch (err) {
      // The root failing is the source failing; a broken branch below it is one branch.
      if (next.depth === 0 || !(err instanceof ProviderError) || FATAL.has(err.code)) throw err;
      result.skipped.push({ url: next.url, reason: `${err.code}: ${err.message}`.slice(0, 160) });
      continue;
    }
    const kind = stacDocKind(doc);
    if (kind === 'unknown') {
      if (next.depth === 0)
        throw new ProviderError(
          'MALFORMED',
          'not a STAC catalogue, collection, item collection or item (no type Catalog/Collection/FeatureCollection/Feature)',
          { retryable: false },
        );
      result.skipped.push({ url: next.url, reason: 'not a STAC document' });
      continue;
    }
    const d = doc as Record<string, unknown>;
    if (kind === 'item') {
      result.items.push({ item: d, base: next.url, own: true });
      continue;
    }
    if (kind === 'item-collection') {
      for (const f of d['features'] as unknown[]) result.items.push({ item: f, base: next.url });
      // An API's /items pages on by rel=next; the next page sits at the same depth.
      const n = follow(linkOf(d, 'next')?.['href'], next.url, next.depth);
      if (n) stack.push(n);
      continue;
    }
    // A catalogue or collection: its links, in document order, items popped before children.
    const children: Array<{ url: string; depth: number }> = [];
    const items: Array<{ url: string; depth: number }> = [];
    for (const l of Array.isArray(d['links']) ? d['links'] : []) {
      if (!isRecord(l)) continue;
      const rel = l['rel'];
      if (rel !== 'child' && rel !== 'item' && rel !== 'items') continue;
      const f = follow(l['href'], next.url, next.depth + 1);
      if (!f) continue;
      (rel === 'item' ? items : children).push(f);
    }
    for (const c of children.reverse()) stack.push(c);
    for (const i of items.reverse()) stack.push(i);
  }
  return result;
}
