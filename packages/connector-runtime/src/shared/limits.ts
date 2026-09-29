/**
 * Sizes and timings more than one connector uses, kept in one place so that a change to
 * one is a change to all (the refactor pass, docs/roadmap/INTEGRATION.md). Each connector
 * used to declare its own copy with the same value; a definition's own `maxBytes` or
 * `maxMessageBytes` still overrides these per source.
 */

/**
 * The response cap for an HTTP request when the definition's endpoint names none: 8 MiB,
 * enough for a large GeoJSON page or a capabilities document, small enough that a source
 * that answers with the wrong thing (a whole archive, an HTML error page gone wrong) is
 * refused before it is parsed.
 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** The cap on one socket message when the definition names none: 1 MiB. */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * A dropped socket or broker connection is reopened after a wait that starts here and
 * doubles on every failed attempt up to `RECONNECT_MAX_MS`, so a source that is down is
 * asked about once a minute rather than hammered, and one that blinked is back in seconds.
 */
export const RECONNECT_MIN_MS = 2_000;
export const RECONNECT_MAX_MS = 60_000;

/** The wait after `ms` for the next reconnect attempt: doubled, never above `RECONNECT_MAX_MS`. */
export function nextRetryMs(ms: number): number {
  return Math.min(RECONNECT_MAX_MS, ms * 2);
}
