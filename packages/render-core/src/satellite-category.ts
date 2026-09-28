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

/**
 * What a satellite of each category is for, in a sentence, where the category says it: the
 * context panel shows it under the category. Nothing for `other` — the category is "not
 * known", and a purpose would be a guess. The military sentence says only what is known: that
 * CelesTrak lists it (or its name says so), not what it does.
 */
export const SATELLITE_CATEGORY_PURPOSE: Readonly<Record<string, string>> = Object.freeze({
  station: 'A crewed space station: people live and work aboard it.',
  starlink: "Broadband internet from SpaceX's Starlink constellation of thousands of satellites in low orbit.",
  comms: 'Communications: relays telephone, television, internet or radio traffic between places on the ground.',
  navigation:
    'Satellite navigation (GPS, GLONASS, Galileo, BeiDou and regional systems): broadcasts timing signals receivers use to find their position.',
  weather: 'Weather observation: images clouds and measures the atmosphere for forecasting.',
  'earth-observation': 'Earth observation: images or measures the land, sea and ice below it.',
  science: 'Science: astronomy, space physics or other research.',
  military:
    'Military: CelesTrak lists it among military satellites, or its name says so. What it does is not published.',
  'rocket-body': 'A spent rocket stage left in orbit after a launch. It does nothing and cannot be steered.',
  debris: 'Debris: a fragment from a break-up, collision or mission. It does nothing and cannot be steered.',
});

/** The purpose sentence for a `satelliteCategory` value, or undefined when the category implies none. */
export function satelliteCategoryPurpose(value: unknown): string | undefined {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SATELLITE_CATEGORY_PURPOSE, value)
    ? SATELLITE_CATEGORY_PURPOSE[value]
    : undefined;
}
