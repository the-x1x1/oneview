/**
 * Satellite categories as the map and the context panel show them. The values are the ones
 * the CelesTrak provider writes to `satelliteCategory` (providers/celestrak categories.ts);
 * the runtime's tests hold the two lists to each other, since neither package may import
 * the other.
 */

/** Categories with a colour of their own (theme.ts `satellite.*`); debris and spent stages share one. */
export const SATELLITE_CATEGORY_SUFFIXES: Readonly<Record<string, string>> = Object.freeze({
  station: 'station',
  starlink: 'starlink',
  comms: 'comms',
  navigation: 'navigation',
  weather: 'weather',
  'earth-observation': 'earth-observation',
  science: 'science',
  military: 'military',
  'rocket-body': 'debris',
  debris: 'debris',
});

export const SATELLITE_CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  station: 'Space station',
  starlink: 'Starlink',
  comms: 'Communications',
  navigation: 'Navigation (GNSS)',
  weather: 'Weather',
  'earth-observation': 'Earth observation',
  science: 'Science',
  military: 'Military (CelesTrak list or name)',
  'rocket-body': 'Rocket body',
  debris: 'Debris',
  other: 'Other / not known',
});

/** The label for a `satelliteCategory` value, or undefined for anything unrecognised. */
export function satelliteCategoryLabel(value: unknown): string | undefined {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SATELLITE_CATEGORY_LABELS, value)
    ? SATELLITE_CATEGORY_LABELS[value]
    : undefined;
}
