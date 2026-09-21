/**
 * Small deterministic string hash (two FNV-1a 32-bit passes with different seeds →
 * 16 hex chars). Not cryptographic; used for stable ids of derived things (queries,
 * clusters) where the input is already a canonical string.
 */
export function stableHash(input: string): string {
  return fnv1a(input, 0x811c9dc5).toString(16).padStart(8, '0') + fnv1a(input, 0x01000193 ^ 0x5bd1e995).toString(16).padStart(8, '0');
}

function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
