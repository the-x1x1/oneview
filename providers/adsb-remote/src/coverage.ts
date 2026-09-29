import { haversineMeters } from '@worldview/world-model';
import type { PointQuery } from './bounds.js';
import { PRIOR_BASELINE, priorAircraft, type Tile } from './tiles.js';

/**
 * What to ask adsb.lol for, one request a poll, when the view is wider than one point query.
 *
 * A regional or continental view — up to MAX_CIRCLES of the 250 nm grid circles (tiles.ts)
 * — is covered circle by circle: every aircraft over the view, not only the commonest types.
 * The circle under the view centre goes first. After it, the circle whose answer is oldest
 * weighted by the square root of how many aircraft it had (the same rule as the types),
 * with two adjustments. A circle not yet asked for counts as CIRCLE_KEEP_MS old and as
 * holding its `TRAFFIC_PRIOR` count (at least UNASKED_GUESS). And a circle whose aircraft are
 * not on the map, or will leave it soon (answer older than CIRCLE_URGENT_MS), counts
 * URGENT_WEIGHT times over — keeping aircraft shown comes before refreshing ones that are.
 * The circle under the view centre counts CENTRE_WEIGHT times over.
 *
 * So the first pass takes the busy terminal areas first and the open sea last, and after
 * it a circle with a few hundred aircraft is refreshed several times as often as one with a
 * handful. Each answer is kept until refreshed or CIRCLE_KEEP_MS old (index.ts). How long a
 * pass takes is the request budget's (budget.ts): at 4–6 requests a minute the contiguous
 * United States (48 circles) takes 8–12 minutes, the busiest circles far less
 * (`coverage.test.ts` measures it on a virtual clock). A wider view than MAX_CIRCLES gets
 * the worldwide rotation described next.
 *
 * adsb.lol answers aircraft within 250 nm of a point, and no wider (its OpenAPI has point,
 * closest, callsign, registration, hex, squawk, type and the mil/LADD/PIA lists). A globe-wide
 * view used to get one 250 nm disc — centred on the middle of the view's bounds, which for the
 * whole world is 0°, 0° in the Gulf of Guinea — and so no aircraft at all.
 *
 * Its type query (`/v2/type/{ICAO type}`) answers every aircraft of one type, worldwide. So a
 * wide view alternates: one poll in three is the point query around the view centre (every
 * aircraft there), the other two ask for the commonest airliner, regional and business-jet
 * types in turn. Nothing is asked for more often than before — still one request a poll — and
 * each type's answer is kept until it is refreshed or ten minutes old, so the world fills in
 * over a few minutes and stays filled. Aircraft of other types (most light aircraft and
 * helicopters) appear within 250 nm of the view centre, or when zoomed in.
 *
 * Military transponders are the other thing a type rotation misses: a tanker, a transport or
 * a patrol aircraft is rarely one of the commonest civil types. adsb.lol lists every aircraft
 * its database marks military (`/v2/mil`, worldwide, a few hundred at a time), so while the
 * view is wide one of the non-point turns a minute (MIL_REFRESH_MS) goes to that list instead
 * of a type — still one request a poll, and the list is kept like a type's answer.
 *
 * Which type next: one never asked for, in list order (commonest first); otherwise the one
 * whose answer is oldest weighted by the square root of how many aircraft it had — the
 * refresh interval that keeps the average age of all the aircraft shown lowest when fetches
 * are what is rationed (a type with a hundred times the aircraft is refreshed ten times as
 * often).
 */
export const WIDE_COVERAGE_TYPES: readonly string[] = Object.freeze([
  // Narrow-body airliners
  'A320',
  'B738',
  'A321',
  'A20N',
  'A21N',
  'B38M',
  'A319',
  'B739',
  'B737',
  'B39M',
  'BCS3',
  'BCS1',
  // Wide-body airliners
  'B77W',
  'B789',
  'A333',
  'B788',
  'A359',
  'B763',
  'B772',
  'A332',
  'B78X',
  'A339',
  'A35K',
  'B744',
  'B748',
  'B77L',
  'A388',
  'B752',
  // Regional
  'E75L',
  'E75S',
  'E190',
  'E195',
  'E290',
  'E295',
  'E170',
  'CRJ9',
  'CRJ7',
  'CRJ2',
  'AT76',
  'AT75',
  'AT72',
  'DH8D',
  // Business and utility
  'C68A',
  'CL35',
  'GLF5',
  'GLF6',
  'GLEX',
  'C56X',
  'E55P',
  'PC12',
  'B350',
  'C208',
]);

/** One poll in this many is the point query around the view centre while the view is wide. */
export const POINT_EVERY = 3;
/** A type asked for this recently is not asked for again, however it scores. */
export const TYPE_MIN_REFRESH_MS = 60_000;
/** How long one type's answer stays on the map without being refreshed (the aircraft expire policy). */
export const TYPE_KEEP_MS = 600_000;
/**
 * The worldwide military list is asked for at most this often while the view is wide. A
 * minute is one poll in six at the ten-second cadence: the list is a few hundred aircraft,
 * moving at transport and tanker speeds, and a minute keeps them within ~15 km of true
 * between refreshes (dead reckoning carries them in between) without starving the types.
 */
export const MIL_REFRESH_MS = 60_000;

/**
 * The most circles a view is covered by. Beyond it (a view much wider than Europe or the
 * contiguous United States, which take ~70 and ~50) a full pass would take longer than the
 * ten minutes an answer is kept at the budget adsb.lol allows (budget.ts), so the worldwide
 * type rotation shows more.
 */
export const MAX_CIRCLES = 80;
/** A circle asked for this recently is not asked for again, however it scores. */
export const CIRCLE_MIN_REFRESH_MS = 30_000;
/** How long one circle's answer stays on the map without being refreshed. */
export const CIRCLE_KEEP_MS = 600_000;
/** The circle under the view centre counts this many times over when choosing what to refresh. */
export const CENTRE_WEIGHT = 4;
/**
 * A circle never asked for is assumed to hold at least this many aircraft (or its
 * `TRAFFIC_PRIOR` count, if higher): the prior table knows the busiest areas, not every
 * busy one, and a circle it misses must still be asked for early in the first pass.
 */
export const UNASKED_GUESS = 50;
/** An answer this old (three quarters of CIRCLE_KEEP_MS) is about to leave the map. */
export const CIRCLE_URGENT_MS = 450_000;
/** Circles not on the map, or about to leave it, count this many times over. */
export const URGENT_WEIGHT = 4;

export type CoverageRequest =
  | { kind: 'point'; query: PointQuery }
  | { kind: 'circle'; tile: Tile }
  | { kind: 'type'; type: string }
  | { kind: 'mil' };

/** The circles over the view and the point it is centred on. */
export interface CircleView {
  tiles: readonly Tile[];
  centre: { latitude: number; longitude: number };
}

interface TypeState {
  fetchedAtMs: number;
  count: number;
}

export class CoveragePlanner {
  private turn = 0;
  private readonly types = new Map<string, TypeState>();
  private mil: TypeState | undefined;
  private readonly circles = new Map<string, TypeState & { answeredAtMs: number | undefined }>();
  private readonly priors = new Map<string, number>();

  constructor(private readonly typeList: readonly string[] = WIDE_COVERAGE_TYPES) {}

  /**
   * The request for this poll. `point` is the point query for the view (undefined when no
   * centre is known); a view it covers whole gets it every poll. `circles`, when the view is
   * wider but covered by at most MAX_CIRCLES, gets one circle a poll.
   */
  next(point: PointQuery | undefined, nowMs: number, circles?: CircleView): CoverageRequest | undefined {
    if (!point) return undefined;
    if (!point.clipped) return { kind: 'point', query: point };
    if (circles && circles.tiles.length > 0 && circles.tiles.length <= MAX_CIRCLES) {
      const tile = this.nextCircle(circles, nowMs);
      return tile ? { kind: 'circle', tile } : undefined;
    }
    const turn = this.turn++;
    if (turn % POINT_EVERY === 0) return { kind: 'point', query: point };
    if (this.militaryDue(nowMs)) return { kind: 'mil' };
    const type = this.nextType(nowMs);
    return type ? { kind: 'type', type } : { kind: 'point', query: point };
  }

  /**
   * The circle to ask for now, or undefined when every circle over the view was asked for
   * within CIRCLE_MIN_REFRESH_MS (the poll then asks for nothing).
   */
  nextCircle(view: CircleView, nowMs: number): Tile | undefined {
    let centreTile: Tile | undefined;
    let centreDist = Infinity;
    for (const t of view.tiles) {
      const d = haversineMeters(t, view.centre);
      if (d < centreDist) {
        centreDist = d;
        centreTile = t;
      }
    }
    // What the operator is looking at comes first while it has never been asked for.
    if (centreTile && !this.circles.has(centreTile.id)) return centreTile;
    let best: Tile | undefined;
    let bestScore = -1;
    for (const t of view.tiles) {
      const s = this.circles.get(t.id);
      const age = s ? nowMs - s.fetchedAtMs : CIRCLE_KEEP_MS;
      if (s && age < CIRCLE_MIN_REFRESH_MS) continue;
      const shown = s?.answeredAtMs !== undefined && nowMs - s.answeredAtMs < CIRCLE_KEEP_MS;
      const count = s ? s.count : Math.max(this.prior(t), UNASKED_GUESS);
      // Aircraft about to drop off the map (or not on it at all) are worth more than
      // fresher positions for ones that will stay.
      const urgent = !shown || age >= CIRCLE_URGENT_MS ? URGENT_WEIGHT : 1;
      const score = age * Math.sqrt(count + 1) * urgent * (t === centreTile ? CENTRE_WEIGHT : 1);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  private prior(t: Tile): number {
    let p = this.priors.get(t.id);
    if (p === undefined) {
      p = priorAircraft(t);
      this.priors.set(t.id, p);
    }
    return p;
  }

  /** A circle's answer arrived: `count` aircraft with a position. */
  recordCircle(id: string, count: number, nowMs: number): void {
    this.circles.set(id, { fetchedAtMs: nowMs, count, answeredAtMs: nowMs });
  }

  /** A circle's request failed: the others go before it again; its count is kept. */
  deferredCircle(id: string, nowMs: number): void {
    const s = this.circles.get(id);
    this.circles.set(id, {
      fetchedAtMs: nowMs,
      count: s?.count ?? this.priors.get(id) ?? PRIOR_BASELINE,
      answeredAtMs: s?.answeredAtMs,
    });
  }

  /**
   * Of the circles over the view: how many have a current answer, how many of those are
   * younger than `recentMs`, and the oldest answer's age. Forgets circles whose answer
   * has expired, so the map does not grow for the life of the process.
   */
  circleSummary(
    tiles: readonly Tile[],
    nowMs: number,
    recentMs = 120_000,
  ): { circles: number; answered: number; recent: number; oldestAgeMs: number | undefined } {
    for (const [id, s] of this.circles) if (nowMs - s.fetchedAtMs > CIRCLE_KEEP_MS) this.circles.delete(id);
    let answered = 0;
    let recent = 0;
    let oldest: number | undefined;
    for (const t of tiles) {
      const s = this.circles.get(t.id);
      if (s?.answeredAtMs === undefined || nowMs - s.answeredAtMs > CIRCLE_KEEP_MS) continue;
      const age = nowMs - s.answeredAtMs;
      answered++;
      if (age <= recentMs) recent++;
      if (oldest === undefined || age > oldest) oldest = age;
    }
    return { circles: tiles.length, answered, recent, oldestAgeMs: oldest };
  }

  /** The type to ask for now, or undefined when every type was asked for within TYPE_MIN_REFRESH_MS. */
  nextType(nowMs: number): string | undefined {
    let best: string | undefined;
    let bestScore = -1;
    for (const type of this.typeList) {
      const s = this.types.get(type);
      if (!s) return type;
      const age = nowMs - s.fetchedAtMs;
      if (age < TYPE_MIN_REFRESH_MS) continue;
      const score = age * Math.sqrt(s.count + 1);
      if (score > bestScore) {
        bestScore = score;
        best = type;
      }
    }
    return best;
  }

  /** A type's answer arrived: `count` aircraft with a position. */
  record(type: string, count: number, nowMs: number): void {
    this.types.set(type, { fetchedAtMs: nowMs, count });
  }

  /** A type's request failed: try the others before it again, without forgetting its count. */
  deferred(type: string, nowMs: number): void {
    const s = this.types.get(type);
    this.types.set(type, { fetchedAtMs: nowMs, count: s?.count ?? 0 });
  }

  /** Whether the worldwide military list is due: never asked for, or asked MIL_REFRESH_MS ago. */
  militaryDue(nowMs: number): boolean {
    return !this.mil || nowMs - this.mil.fetchedAtMs >= MIL_REFRESH_MS;
  }

  /** The military list arrived: `count` aircraft with a position. */
  recordMilitary(count: number, nowMs: number): void {
    this.mil = { fetchedAtMs: nowMs, count };
  }

  /** The military list's request failed: types get the turns until it is due again. */
  deferredMilitary(nowMs: number): void {
    this.mil = { fetchedAtMs: nowMs, count: this.mil?.count ?? 0 };
  }

  /** How many types have an answer, the oldest answer's age, and whether the military list is current. */
  summary(nowMs: number): { types: number; oldestAgeMs: number | undefined; military: boolean } {
    let oldest: number | undefined;
    let n = 0;
    for (const s of this.types.values()) {
      const age = nowMs - s.fetchedAtMs;
      if (age > TYPE_KEEP_MS) continue;
      n++;
      if (oldest === undefined || age > oldest) oldest = age;
    }
    const military = !!this.mil && this.mil.count > 0 && nowMs - this.mil.fetchedAtMs <= TYPE_KEEP_MS;
    return { types: n, oldestAgeMs: oldest, military };
  }
}

/** adsb.lol's type query: every aircraft of one ICAO type designator, worldwide. */
export function typeQueryUrl(base: string, type: string): string {
  if (!/^[A-Z0-9]{2,4}$/.test(type)) throw new Error(`not an ICAO type designator: ${type}`);
  return `${base}/type/${type}`;
}

/** adsb.lol's military list: every aircraft its database marks military, worldwide. */
export function militaryQueryUrl(base: string): string {
  return `${base}/mil`;
}
