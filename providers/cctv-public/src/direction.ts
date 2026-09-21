/**
 * Adapted from gods-eye-view src/data/directionText.js (MIT).
 *
 * Compass text → heading in degrees. Only for *dedicated* direction fields (a
 * catalog column that means "the camera faces …"); never run it over free-form
 * names, where street names such as "West Ave" would produce a confident wrong
 * bearing. Returns undefined when the text is not a recognisable facing.
 */
const POINTS: ReadonlyArray<[RegExp, number]> = [
  [/^(NORTHBOUND|NB)$/, 0], [/^(SOUTHBOUND|SB)$/, 180], [/^(EASTBOUND|EB)$/, 90], [/^(WESTBOUND|WB)$/, 270],
  [/^(NNE)$/, 22.5], [/^(NORTHEAST|NE)$/, 45], [/^(ENE)$/, 67.5], [/^(ESE)$/, 112.5], [/^(SOUTHEAST|SE)$/, 135], [/^(SSE)$/, 157.5],
  [/^(SSW)$/, 202.5], [/^(SOUTHWEST|SW)$/, 225], [/^(WSW)$/, 247.5], [/^(WNW)$/, 292.5], [/^(NORTHWEST|NW)$/, 315], [/^(NNW)$/, 337.5],
  [/^(NORTH|N)$/, 0], [/^(SOUTH|S)$/, 180], [/^(EAST|E)$/, 90], [/^(WEST|W)$/, 270],
];

export function directionToHeading(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (!text || text.length > 10) return undefined;
  for (const [re, deg] of POINTS) if (re.test(text)) return deg;
  return undefined;
}

export function normalizeHeading(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return ((value % 360) + 360) % 360;
}
