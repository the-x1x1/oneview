/**
 * HLS playlist containment and rewriting for the loopback relay.
 *
 * A registered HLS source is a playlist URL. Everything the relay will ever fetch
 * for that camera must live on the same origin, under the playlist's directory.
 * Playlists are rewritten so every reference (segments, nested playlists, keys,
 * init maps) points back at the relay: `<relay camera url>/r/<path relative to the
 * registered directory>`. A reference that escapes the directory is dropped, never
 * proxied.
 */
export interface HlsBase {
  origin: string;
  /** Directory of the registered playlist, always ending in "/". */
  dir: string;
}

export function hlsBaseFor(playlistUrl: string): HlsBase {
  const u = new URL(playlistUrl);
  const dir = u.pathname.endsWith('/') ? u.pathname : u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
  return { origin: u.origin, dir };
}

/**
 * Resolve `reference` against `fromUrl` and return its path (plus query) relative to
 * the registered base directory, or undefined when it escapes the base.
 */
export function containedRelativePath(reference: string, fromUrl: string, base: HlsBase): string | undefined {
  let target: URL;
  try {
    target = new URL(reference, fromUrl);
  } catch {
    return undefined;
  }
  if (target.origin !== base.origin) return undefined;
  if (!target.pathname.startsWith(base.dir)) return undefined;
  if (target.username || target.password) return undefined;
  const rel = target.pathname.slice(base.dir.length);
  if (rel.length === 0 || rel.includes('..')) return undefined;
  return `${rel}${target.search}`;
}

/** Resolve a relay `/r/<rel>` path back to an absolute upstream URL inside the base, or undefined. */
export function resolveContained(rel: string, base: HlsBase): string | undefined {
  if (!rel || rel.startsWith('/') || rel.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('//'))
    return undefined;
  let target: URL;
  try {
    target = new URL(rel, `${base.origin}${base.dir}`);
  } catch {
    return undefined;
  }
  if (target.origin !== base.origin || !target.pathname.startsWith(base.dir)) return undefined;
  return target.toString();
}

const URI_ATTR = /URI="([^"]*)"/g;

/**
 * Rewrite a playlist body. `relayPrefix` is the relay URL prefix that `/r/<rel>` is
 * appended to. Lines whose reference escapes the base are removed together with the
 * tag line immediately preceding them (EXTINF etc.) so the playlist stays valid.
 */
export function rewritePlaylist(text: string, playlistUrl: string, base: HlsBase, relayPrefix: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const toRelay = (ref: string): string | undefined => {
    const rel = containedRelativePath(ref, playlistUrl, base);
    return rel === undefined ? undefined : `${relayPrefix}/r/${encodeRelPath(rel)}`;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      out.push('');
      continue;
    }
    if (trimmed.startsWith('#')) {
      let dropped = false;
      const rewritten = trimmed.replace(URI_ATTR, (_m, uri: string) => {
        const relay = toRelay(uri);
        if (relay === undefined) {
          dropped = true;
          return 'URI=""';
        }
        return `URI="${relay}"`;
      });
      if (dropped) continue;
      out.push(rewritten);
      continue;
    }
    const relay = toRelay(trimmed);
    if (relay === undefined) {
      // Drop the media line and its preceding tag lines back to the last blank/URI line.
      while (
        out.length &&
        out[out.length - 1]!.startsWith('#EXT') &&
        !out[out.length - 1]!.startsWith('#EXTM3U') &&
        !out[out.length - 1]!.startsWith('#EXT-X-VERSION') &&
        !out[out.length - 1]!.startsWith('#EXT-X-TARGETDURATION') &&
        !out[out.length - 1]!.startsWith('#EXT-X-MEDIA-SEQUENCE')
      )
        out.pop();
      continue;
    }
    out.push(relay);
  }
  return out.join('\n');
}

/** Keep path separators and query intact; encode everything else that could confuse a URL parser. */
function encodeRelPath(rel: string): string {
  const q = rel.indexOf('?');
  const path = q >= 0 ? rel.slice(0, q) : rel;
  const query = q >= 0 ? rel.slice(q) : '';
  return (
    path
      .split('/')
      .map((seg) => encodeURIComponent(decodeSafe(seg)))
      .join('/') + query
  );
}

function decodeSafe(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export function looksLikePlaylist(url: string, contentType: string | undefined): boolean {
  if (contentType && /mpegurl/i.test(contentType)) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}
