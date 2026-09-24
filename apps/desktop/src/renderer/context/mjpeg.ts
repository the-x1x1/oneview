/**
 * Reading an MJPEG stream in the renderer, frame by frame.
 *
 * An `<img>` pointed at a multipart stream shows it — until the server closes the connection.
 * Taiwan's Highway Bureau closes each camera's stream after about 35 s (measured 2026-09-23),
 * and Chromium then blanks the image without an `error` event, so nothing could notice and
 * reopen it. Reading the stream here instead, the last frame stays on screen while the stream
 * is reopened, and a stream that never delivers a frame is reported.
 *
 * Frames are cut at JPEG markers (FF D8 … FF D9) rather than at the multipart boundary: a
 * camera's boundary string is whatever its server chose, and the markers are the same for all.
 */

/** A frame larger than this is not a camera frame; the buffer is dropped rather than grown without end. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Complete JPEGs in `buffer`, and what is left after the last one (the start of the next).
 * Bytes before the first start-of-image (multipart headers) are discarded.
 */
export function extractJpegFrames(buffer: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  const frames: Uint8Array[] = [];
  let i = 0;
  let start = -1;
  let cut = 0;
  while (i + 1 < buffer.length) {
    if (buffer[i] === 0xff) {
      const next = buffer[i + 1];
      if (start < 0 && next === 0xd8) {
        start = i;
        i += 2;
        continue;
      }
      if (start >= 0 && next === 0xd9) {
        frames.push(buffer.slice(start, i + 2));
        cut = i + 2;
        start = -1;
        i += 2;
        continue;
      }
    }
    i++;
  }
  const from = start >= 0 ? start : Math.max(cut, buffer.length - 1);
  let rest = buffer.slice(from);
  if (rest.length > MAX_FRAME_BYTES) rest = new Uint8Array(0);
  return { frames, rest };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export interface MjpegReaderEvents {
  /** A whole frame arrived. */
  onFrame(jpeg: Uint8Array): void;
  /** The stream ended or failed; `framesThisConnection` says whether it delivered anything. */
  onDrop(framesThisConnection: number): void;
}

/**
 * Read one connection of an MJPEG stream until it ends, fails or `signal` aborts. Resolves when
 * it is over; reconnecting is the caller's decision.
 */
export async function readMjpeg(
  url: string,
  events: MjpegReaderEvents,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let frames = 0;
  try {
    const res = await fetchImpl(url, { signal, cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    let buffer: Uint8Array = new Uint8Array(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const got = extractJpegFrames(concat(buffer, value));
        buffer = got.rest;
        for (const f of got.frames) {
          frames++;
          events.onFrame(f);
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  } catch {
    if (signal.aborted) return;
  }
  if (!signal.aborted) events.onDrop(frames);
}
