import type { HistoryRow } from './row.js';

/**
 * Which history rows say nothing new.
 *
 * An observation id is deterministic — provider, external id and the time the source says
 * the observation describes (provider-sdk `observationId`) — so two rows with the same id
 * describe the same moment of the same thing. They are the same observation when their
 * content matches too: the source record's hash where the provider supplies one, otherwise
 * the normalized payload, position and geometry.
 *
 * The source hash wins over position on purpose. CelesTrak's observation is the element
 * set: `observedAt` is its epoch, and the position is propagated from it every poll, so
 * two polls of one element set differ in position and in nothing the source said. Before
 * this, every 15-second propagation of 5,000 satellites was written to history — about a
 * million rows an hour, for element sets that change a few times a day; the operator's
 * history had reached 17 GB within a day. An earthquake whose magnitude is revised keeps
 * its id and changes its hash, so a revision is still written.
 */
export function observationFingerprint(
  row: Pick<HistoryRow, 'observationId' | 'payloadJson' | 'lat' | 'lon' | 'altitudeM' | 'geometryJson'>,
  sourceHash: string | undefined,
): number {
  const content =
    sourceHash ??
    `${row.payloadJson}|${row.lat ?? ''},${row.lon ?? ''},${row.altitudeM ?? ''}|${row.geometryJson ?? ''}`;
  return hash53(`${row.observationId}\u0000${content}`);
}

/** The fingerprint of a stored row (its own `rawPayloadHash`, when it kept one). */
export function rowFingerprint(row: HistoryRow): number {
  return observationFingerprint(row, row.rawPayloadHash);
}

/**
 * A 53-bit FNV-1a over UTF-16 code units: two 32-bit lanes with different offsets. Not
 * cryptographic — a collision can only make one genuinely new observation of an object
 * look like that same object's previous one, at odds of about 1 in 2⁵³.
 */
export function hash53(s: string): number {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0) * 0x200000 + ((b >>> 0) & 0x1fffff);
}
