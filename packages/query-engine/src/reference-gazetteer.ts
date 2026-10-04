import { normalizePlaceName, StaticGazetteer, type GazetteerEntry, type PlaceKind } from './gazetteer.js';

/**
 * Countries and first-level regions (states, provinces, prefectures…) from the Natural
 * Earth label file the app already bundles for the map (`worldview-reference-labels@1`,
 * tools/dev/reference-data/build.mjs): 242 countries and ~4,500 regions, each with a label
 * point and no outline.
 *
 * The built-in gazetteer knows a dozen US states. "North Carolina", "Bavaria" or "Ontario"
 * found nothing — while the globe had just drawn the name. Entries the built-in gazetteer
 * already has (same kind, same name) are left to it, since it carries bounds.
 */
export const REFERENCE_LABELS_FORMAT = 'worldview-reference-labels@1';

type CountryRow = [name: string, lon: number, lat: number, minZoom: number, maxZoom: number, rank: number];
type StateRow = [...CountryRow, country: string];

export interface ReferenceLabelsFile {
  format: string;
  countries: unknown[];
  states: unknown[];
}

export function isReferenceLabelsFile(v: unknown): v is ReferenceLabelsFile {
  const f = v as Partial<ReferenceLabelsFile> | null;
  return (
    !!f &&
    typeof f === 'object' &&
    f.format === REFERENCE_LABELS_FORMAT &&
    Array.isArray(f.countries) &&
    Array.isArray(f.states)
  );
}

function row(v: unknown, withCountry: boolean): StateRow | CountryRow | undefined {
  if (!Array.isArray(v) || v.length < (withCountry ? 7 : 6)) return undefined;
  const [name, lon, lat] = v as unknown[];
  if (typeof name !== 'string' || !name.trim() || name.length > 120) return undefined;
  if (typeof lon !== 'number' || typeof lat !== 'number') return undefined;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  if (withCountry && typeof v[6] !== 'string') return undefined;
  return v as StateRow;
}

/** The label file's places as gazetteer entries, less those `known` says are already covered. */
export function referenceEntries(
  file: ReferenceLabelsFile,
  known: (name: string, kind: PlaceKind) => boolean = () => false,
): GazetteerEntry[] {
  const out: GazetteerEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: GazetteerEntry) => {
    if (seen.has(entry.id) || known(entry.name, entry.kind)) return;
    seen.add(entry.id);
    out.push(entry);
  };
  for (const raw of file.countries) {
    const r = row(raw, false);
    if (!r) continue;
    add({
      id: `ne:country:${slug(r[0])}`,
      name: r[0],
      kind: 'country',
      position: { latitude: r[2], longitude: r[1] },
    });
  }
  for (const raw of file.states) {
    const r = row(raw, true) as StateRow | undefined;
    if (!r) continue;
    const country = r[6].slice(0, 3).toUpperCase();
    add({
      id: `ne:region:${country}:${slug(r[0])}`,
      name: r[0],
      kind: 'region',
      position: { latitude: r[2], longitude: r[1] },
      countryCode: country,
    });
  }
  return out;
}

export function referenceGazetteer(
  file: ReferenceLabelsFile,
  known?: (name: string, kind: PlaceKind) => boolean,
  places?: ReferencePlacesFile,
): StaticGazetteer {
  return new StaticGazetteer([...referenceEntries(file, known), ...(places ? cityEntries(places) : [])], 'reference');
}

/**
 * Cities and towns from Natural Earth's populated places (`worldview-reference-places@1`,
 * tools/dev/reference-data/build.mjs): about 7,300, every capital and every sizeable city,
 * with its region and country. Offline search knew 61 cities; Helsinki and Kansas City were
 * found only online. Not drawn on the map — the label file stays countries and regions.
 */
export const REFERENCE_PLACES_FORMAT = 'worldview-reference-places@1';

export interface ReferencePlacesFile {
  format: string;
  cities: unknown[];
}

export function isReferencePlacesFile(v: unknown): v is ReferencePlacesFile {
  const f = v as Partial<ReferencePlacesFile> | null;
  return !!f && typeof f === 'object' && f.format === REFERENCE_PLACES_FORMAT && Array.isArray(f.cities);
}

/** The largest population the importance scale reaches (Tokyo's metro, ~35 million). */
const IMPORTANCE_FULL_POPULATION = 35_000_000;

/** 0..1 on a log scale: a town of 1,000 about 0.4, a city of a million 0.8, Tokyo 1. */
export function populationImportance(population: number): number {
  if (!(population > 0)) return 0;
  return Math.round(Math.min(1, Math.log10(population + 1) / Math.log10(IMPORTANCE_FULL_POPULATION)) * 1000) / 1000;
}

/** `[name, lon, lat, country, region, population, capital, aliases]` rows as city entries; bad rows dropped. */
export function cityEntries(file: ReferencePlacesFile): GazetteerEntry[] {
  const out: GazetteerEntry[] = [];
  const seen = new Set<string>();
  for (const raw of file.cities) {
    if (!Array.isArray(raw) || raw.length < 8) continue;
    const [name, lon, lat, country, region, population, capital, aliases] = raw as unknown[];
    if (typeof name !== 'string' || !name.trim() || name.length > 120) continue;
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const cc = typeof country === 'string' ? country.slice(0, 3).toUpperCase() : '';
    const reg = typeof region === 'string' ? region.trim().slice(0, 120) : '';
    const id = `ne:city:${cc || 'xx'}:${slug(reg) || '-'}:${slug(name)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const alias =
      typeof aliases === 'string' && aliases
        ? aliases
            .split('|')
            .map((a) => a.trim())
            .filter((a) => a && a.length <= 120 && !/^[A-Z0-9]{3,4}$/.test(a))
        : [];
    out.push({
      id,
      name: name.trim(),
      kind: 'city',
      position: { latitude: lat, longitude: lon },
      ...(cc ? { countryCode: cc } : {}),
      ...(reg && normalizePlaceName(reg) !== normalizePlaceName(name) ? { region: reg } : {}),
      importance: Math.min(
        1,
        populationImportance(typeof population === 'number' ? population : 0) + (capital === 1 ? 0.05 : 0),
      ),
      ...(alias.length ? { aliases: alias } : {}),
    });
  }
  return out;
}

function slug(name: string): string {
  return normalizePlaceName(name).replace(/\s+/g, '-');
}
