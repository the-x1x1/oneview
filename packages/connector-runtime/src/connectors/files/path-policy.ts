/**
 * What a definition may name as its file: a path relative to the folder the operator
 * granted, and nothing that could leave it. This is the connector's own check, made when
 * the definition is validated and again before every read; the host makes the final one
 * against the real file system (links and junctions resolved — amendment A2), so the two
 * together refuse a path outside the folder whichever side is wrong.
 *
 * Refused: absolute paths (`/x`, `\x`), drive letters (`C:`), UNC and device paths
 * (`\\server\share`, `//server`, `\\?\`, `\\.\`), any `:` (URL schemes, Windows alternate
 * data streams), `..`, empty segments, NUL and control characters, the characters Windows
 * forbids in names (`<>"|?*`), segments ending in a dot or a space (Windows strips them, so
 * two names would reach one file), and the reserved device names (`CON`, `NUL`, `COM1`…).
 */
export const MAX_FILE_PATH_LENGTH = 1024;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const FORBIDDEN = /[<>"|?*]/;

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export type PathVerdict = { ok: true; path: string; segments: string[] } | { ok: false; reason: string };

export function checkRelativePath(input: unknown): PathVerdict {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, reason: 'the file path is empty' };
  if (input.length > MAX_FILE_PATH_LENGTH)
    return { ok: false, reason: `the file path is longer than ${MAX_FILE_PATH_LENGTH} characters` };
  if (hasControlCharacter(input)) return { ok: false, reason: 'the file path contains a control character' };
  if (/^[\\/]{2}/.test(input))
    return { ok: false, reason: 'the file path is a UNC or device path; name a file inside the granted folder' };
  if (/^[\\/]/.test(input))
    return { ok: false, reason: 'the file path is absolute; name it relative to the granted folder' };
  if (/^[A-Za-z]:/.test(input))
    return { ok: false, reason: 'the file path names a drive; name it relative to the granted folder' };
  if (input.includes(':')) return { ok: false, reason: 'the file path contains ":" (a URL, a drive or a stream)' };
  if (FORBIDDEN.test(input))
    return { ok: false, reason: 'the file path contains a character Windows forbids (<>"|?*)' };
  const segments = input.split(/[\\/]/);
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === '') return { ok: false, reason: 'the file path has an empty segment' };
    if (segment === '.') continue;
    if (segment === '..') return { ok: false, reason: 'the file path climbs out of the granted folder ("..")' };
    if (segment === '~') return { ok: false, reason: 'the file path starts from a home folder ("~")' };
    if (/[. ]$/.test(segment))
      return { ok: false, reason: `the segment "${segment}" ends in a dot or a space, which Windows removes` };
    if (WINDOWS_RESERVED.test(segment))
      return { ok: false, reason: `"${segment}" is a device name on Windows, not a file` };
    kept.push(segment);
  }
  if (kept.length === 0) return { ok: false, reason: 'the file path names the folder itself, not a file' };
  return { ok: true, path: kept.join('/'), segments: kept };
}

/** The extension of a checked path, lower-case, without the dot (`''` when there is none). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
