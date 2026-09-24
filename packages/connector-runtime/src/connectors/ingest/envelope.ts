/**
 * The ingest envelope (phase `ingest`): what a pusher POSTs to a source's loopback listener.
 *
 * ```json
 * { "schema": "oneview.ingest.v1", "source": "<definition id>", "records": [ … ] }
 * ```
 *
 * or, for glue that cannot wrap its output, a bare JSON array of records. Each record is
 * mapped by the definition's `mapping`, like any connector's. A push is a delta: the records
 * that changed, never the whole state. Nothing here reads the network or the token; the
 * host has already admitted the request (path, method, bearer token, size, rate).
 */
export const INGEST_SCHEMA_ID = 'oneview.ingest.v1';
/** Records one push may carry; the rest are rejected with a reason. */
export const MAX_RECORDS_PER_PUSH = 10_000;
const ENVELOPE_KEYS = new Set(['schema', 'source', 'records']);

export type EnvelopeResult =
  | { ok: true; records: unknown[]; form: 'envelope' | 'array' }
  | { ok: false; reason: string };

/**
 * The records in a pushed body, or why the body is refused (a 400 for the pusher). `source`
 * is the definition id the listener belongs to: an envelope for another source is refused,
 * so a flow wired to the wrong URL says so instead of feeding the wrong layer.
 */
export function parseEnvelope(body: Uint8Array, source: string): EnvelopeResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return { ok: false, reason: 'the body is not UTF-8 text' };
  }
  if (!text.trim()) return { ok: false, reason: 'the body is empty; send an envelope or a JSON array' };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the body is not JSON' };
  }
  if (Array.isArray(doc)) return { ok: true, records: doc, form: 'array' };
  if (!doc || typeof doc !== 'object')
    return { ok: false, reason: `expected the ${INGEST_SCHEMA_ID} envelope or a JSON array of records` };
  const env = doc as Record<string, unknown>;
  if (env.schema !== INGEST_SCHEMA_ID)
    return {
      ok: false,
      reason:
        env.schema === undefined
          ? `expected the ${INGEST_SCHEMA_ID} envelope (no "schema") or a JSON array of records`
          : `schema ${describe(env.schema)} is not ${INGEST_SCHEMA_ID}`,
    };
  const unknown = Object.keys(env).filter((k) => !ENVELOPE_KEYS.has(k));
  if (unknown.length)
    return { ok: false, reason: `the envelope has unknown field(s): ${unknown.slice(0, 5).map(describe).join(', ')}` };
  if (env.source !== source)
    return { ok: false, reason: `source ${describe(env.source)} is not this listener's source "${source}"` };
  if (!Array.isArray(env.records)) return { ok: false, reason: '"records" must be an array' };
  return { ok: true, records: env.records, form: 'envelope' };
}

/** A value quoted for a refusal message: short, printable, never the whole body back. */
function describe(v: unknown): string {
  const s = v === undefined ? 'missing' : String(JSON.stringify(v));
  const printable = s.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > 60 ? `${printable.slice(0, 57)}...` : printable;
}
