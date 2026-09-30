import { open, stat } from 'node:fs/promises';

/**
 * The installed world pack's PMTiles basemap, served to the renderer over the app scheme
 * (`worldview://app/__pack/basemap.pmtiles`) so the 2D map can draw it with no network and
 * no file: URL. A PMTiles reader asks for byte ranges — the header, then each directory and
 * tile — so this answers `Range: bytes=a-b` with a 206 and just those bytes, never the whole
 * archive (a country extract is hundreds of megabytes).
 *
 * Same origin as the page, so it needs no CORS and no Content-Security-Policy exception.
 */
export const PACK_BASEMAP_ROUTE = '/__pack/basemap.pmtiles';

/** The most a single range may ask for: a PMTiles directory or tile is far smaller. */
export const MAX_RANGE_BYTES = 16 * 1024 * 1024;

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` against a file of `size` bytes; undefined when unreadable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return undefined;
  return { start, end };
}

/**
 * The Response for a request to the route: 206 with the asked range, 200 with the whole file
 * only when it is small enough, 404 when no pack provides a basemap, 416 for a range past its
 * end. `file` is the archive's path, looked up per request (a pack can be installed or
 * switched off while the app runs).
 */
export async function packBasemapResponse(request: Request, file: string | undefined): Promise<Response> {
  if (!file) return new Response('No installed world pack provides a basemap', { status: 404 });
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return new Response('The world pack basemap could not be read', { status: 404 });
  }
  const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const asked = request.headers.get('range');
  const range = asked ? parseRange(asked, size) : { start: 0, end: size - 1 };
  if (!range) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  const length = range.end - range.start + 1;
  if (length > MAX_RANGE_BYTES)
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  const handle = await open(file, 'r');
  try {
    const bytes = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, range.start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const body = read === length ? bytes : bytes.subarray(0, read);
    return asked
      ? new Response(body, {
          status: 206,
          headers: {
            ...headers,
            'Content-Length': String(body.byteLength),
            'Content-Range': `bytes ${range.start}-${range.start + body.byteLength - 1}/${size}`,
          },
        })
      : new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(body.byteLength) } });
  } finally {
    await handle.close();
  }
}
