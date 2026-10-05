import { readPath, type PaginationSpec } from '@worldview/connector-sdk';

/**
 * Reusable pagination (directive §11): the connector asks `first()` for the first request's
 * parameters, hands each response to `next()`, and stops when it answers undefined. A
 * strategy never issues more than `maxPages` requests (default 10; the schema caps it at
 * 200), and a `next-link` is followed only on the endpoint's own origin.
 */
export interface PageRequest {
  /** Query parameters to add or replace. */
  query: Record<string, string>;
  /** A whole URL to use instead (next-link). */
  url?: string;
}

export const DEFAULT_MAX_PAGES = 10;

export interface Paginator {
  first(): PageRequest;
  /**
   * The request for the page after `body`, given how many records it held (and the response's
   * headers, lower-cased, for `link-header`); undefined when done.
   */
  next(
    body: unknown,
    recordsInPage: number,
    pageIndex: number,
    headers?: Readonly<Record<string, string>>,
  ): PageRequest | undefined;
  readonly maxPages: number;
}

export function createPaginator(spec: PaginationSpec | undefined, endpointUrl: string): Paginator {
  const max = spec && spec.strategy !== 'none' ? (spec.maxPages ?? DEFAULT_MAX_PAGES) : 1;
  if (!spec || spec.strategy === 'none') return { maxPages: 1, first: () => ({ query: {} }), next: () => undefined };
  switch (spec.strategy) {
    case 'page-number': {
      const first = spec.firstPage ?? 1;
      const size = spec.size;
      const q = (page: number) => ({
        query: {
          [spec.pageParam]: String(page),
          ...(spec.sizeParam && size ? { [spec.sizeParam]: String(size) } : {}),
        },
      });
      return {
        maxPages: max,
        first: () => q(first),
        next: (_body, n, i) => (n === 0 || (size !== undefined && n < size) ? undefined : q(first + i + 1)),
      };
    }
    case 'offset-limit': {
      const q = (offset: number) => ({
        query: { [spec.offsetParam]: String(offset), [spec.limitParam]: String(spec.limit) },
      });
      return {
        maxPages: max,
        first: () => q(0),
        next: (_body, n, i) => (n < spec.limit ? undefined : q((i + 1) * spec.limit)),
      };
    }
    case 'cursor':
      return {
        maxPages: max,
        first: () => ({ query: {} }),
        next: (body, n) => {
          if (n === 0) return undefined;
          const cursor = readPath(body, spec.cursorPath);
          if (cursor === undefined || cursor === null || cursor === '' || typeof cursor === 'object') return undefined;
          return { query: { [spec.cursorParam]: String(cursor) } };
        },
      };
    case 'next-link':
      return {
        maxPages: max,
        first: () => ({ query: {} }),
        next: (body) => followLink(readPath(body, spec.nextLinkPath), endpointUrl),
      };
    case 'link-header':
      return {
        maxPages: max,
        first: () => ({ query: {} }),
        next: (_body, n, _i, headers) =>
          n === 0 ? undefined : followLink(nextFromLinkHeader(headers?.['link']), endpointUrl),
      };
  }
}

/** A next page's URL, followed only on the endpoint's own origin and never with credentials in it. */
function followLink(link: unknown, endpointUrl: string): PageRequest | undefined {
  if (typeof link !== 'string' || !link) return undefined;
  const origin = new URL(endpointUrl.replace('{TOKEN}', 'TOKEN')).origin;
  let u: URL;
  try {
    u = new URL(link, endpointUrl);
  } catch {
    return undefined;
  }
  // Only the endpoint's own origin: a link elsewhere is not followed, whatever it says.
  if (u.origin !== origin || u.username || u.password) return undefined;
  return { query: {}, url: u.toString() };
}

/**
 * The `rel="next"` target of an RFC 8288 `Link` header (`<https://…?page=2>; rel="next",
 * <…>; rel="last"`). A `rel` may list several relation types (`rel="next prefetch"`);
 * parameters are matched case-insensitively. Undefined when there is none.
 */
export function nextFromLinkHeader(header: string | undefined): string | undefined {
  if (!header || header.length > 16 * 1024) return undefined;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = /^\s*<([^>]*)>(.*)$/s.exec(part);
    if (!m) continue;
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(m[2]!);
    const types = (rel?.[1] ?? rel?.[2] ?? '').toLowerCase().split(/\s+/);
    if (types.includes('next')) return m[1];
  }
  return undefined;
}
