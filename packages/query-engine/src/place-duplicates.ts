import { haversineMeters, type GeoPosition } from '@worldview/world-model';
import type { SearchResult } from '@worldview/ipc-contract';
import { normalizePlaceName, type GazetteerHit, type PlaceKind } from './gazetteer.js';

/**
 * One place, one result. The same city or airport can reach a search from several indexes —
 * the built-in list, the Natural Earth reference labels, and every installed worldpack — each
 * under its own id, so "Honolulu" listed Honolulu twice and its airport three times.
 *
 * Two places are the same when they have the same kind, the same name once normalized
 * (case, accents and punctuation ignored), and lie within DUPLICATE_RADIUS_M of each other
 * for that kind: a city's centre moves a few kilometres between datasets, an airport's
 * reference point less. The higher-scoring one is kept, and takes from the other what it
 * lacks (bounds, country code, a subtitle carrying a code). Coordinates are never collapsed.
 */
export const DUPLICATE_RADIUS_M: Readonly<Record<Exclude<PlaceKind, 'coordinate'>, number>> = Object.freeze({
  country: 1_000_000,
  region: 150_000,
  island: 20_000,
  city: 15_000,
  airport: 3_000,
  port: 5_000,
  poi: 1_000,
});

interface PlaceLike {
  name: string;
  kind: PlaceKind;
  position?: GeoPosition;
}

export function samePlace(a: PlaceLike, b: PlaceLike): boolean {
  if (a.kind !== b.kind || a.kind === 'coordinate') return false;
  if (!a.position || !b.position) return false;
  if (normalizePlaceName(a.name) !== normalizePlaceName(b.name)) return false;
  return haversineMeters(a.position, b.position) <= DUPLICATE_RADIUS_M[a.kind];
}

/** Gazetteer hits, best first, with every later duplicate of a kept one folded into it. */
export function collapseDuplicateHits(hits: readonly GazetteerHit[]): GazetteerHit[] {
  const kept: GazetteerHit[] = [];
  for (const hit of hits) {
    const into = kept.find((k) => samePlace(k, hit));
    if (!into) {
      kept.push({ ...hit });
      continue;
    }
    if (!into.bounds && hit.bounds) into.bounds = hit.bounds;
    if (!into.countryCode && hit.countryCode) into.countryCode = hit.countryCode;
  }
  return kept;
}

/**
 * The kind a place result's subtitle names. Both producers write it first: the query
 * engine as the capitalized gazetteer kind ("City", "Poi"), a worldpack as its label
 * ("City", "Feature", "Place").
 */
export function placeResultKind(result: SearchResult): PlaceKind | undefined {
  if (result.kind !== 'place') return undefined;
  const head = (result.subtitle ?? '').split('·')[0]!.trim().toLowerCase();
  switch (head) {
    case 'country':
    case 'region':
    case 'city':
    case 'island':
    case 'airport':
    case 'port':
      return head;
    case 'poi':
    case 'place':
    case 'feature':
      return 'poi';
    default:
      return undefined;
  }
}

/**
 * Search results in their order, with a later place result folded into an earlier one when
 * they are the same place. The merged result sits where the earlier one did, with the
 * higher score of the two. It is the worldpack's record when one of the two came from an
 * installed pack (the pack is the authority for its region, and says so offline), otherwise
 * the earlier one's; it takes the other's bounds when it had none, and whichever subtitle
 * says more.
 */
export function collapseDuplicatePlaces(results: readonly SearchResult[]): SearchResult[] {
  const out: SearchResult[] = [];
  const places: Array<{ at: number; like: PlaceLike }> = [];
  for (const r of results) {
    const kind = placeResultKind(r);
    if (!kind || !r.position) {
      out.push(r);
      continue;
    }
    const like: PlaceLike = { name: r.title, kind, position: r.position };
    const dup = places.find((p) => samePlace(p.like, like));
    if (!dup) {
      places.push({ at: out.length, like });
      out.push({ ...r });
      continue;
    }
    const earlier = out[dup.at]!;
    const packWins = r.source === 'worldpack' && earlier.source !== 'worldpack';
    const kept: SearchResult = packWins ? { ...r } : earlier;
    const other = packWins ? earlier : r;
    kept.score = Math.max(earlier.score, r.score);
    if (!kept.bounds && other.bounds) {
      kept.bounds = other.bounds;
      delete kept.zoom;
    }
    if (other.subtitle && segments(other.subtitle) > segments(kept.subtitle)) kept.subtitle = other.subtitle;
    out[dup.at] = kept;
  }
  return out;
}

function segments(subtitle: string | undefined): number {
  return subtitle ? subtitle.split('·').filter((s) => s.trim()).length : 0;
}
