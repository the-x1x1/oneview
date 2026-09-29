/**
 * How many requests adsb.lol gets, and in what order.
 *
 * adsb.lol publishes no number. Its API README says "Rate limits are dynamic based on the
 * environment load. If you get 4xx errors, you are doing something wrong." (github.com/adsblol/api,
 * read 2026-09-28); its OpenAPI (api.adsb.lol/api/openapi.json) documents no key, header or
 * feeder tier today, only that "in the future, you will require an API key which you can get
 * by feeding to adsb.lol". What there is to go on:
 *
 *  - the operator's laptop: at one request every ten seconds (6 a minute, from polls alone)
 *    adsb.lol answered 429 often, and a flight-route lookup made between two polls was
 *    refused locally while the host was pacing adsb.lol after one;
 *  - a public bug report against another client (github.com/BigBodyCobain/Shadowbroker,
 *    issue 572): six large queries at once all answered 429, the same six one after another
 *    all answered 200 — bursts are what the limiter punishes first.
 *
 * So the budget is found, not configured: additive increase, multiplicative decrease, the
 * way TCP finds a link's capacity. It starts at START_PER_MIN, below the rate that drew the
 * 429s, and adds INCREASE_PER_SUCCESS a minute for every answered request up to MAX_PER_MIN
 * (one request per ten-second poll, the most the host's cadence allows). A 429 halves it
 * (down to MIN_PER_MIN) and nothing is sent before the Retry-After has passed. The rate a
 * 429 arrived at is remembered for CEILING_MEMORY_MS: below 80 % of it the budget climbs at
 * the normal pace, above it at a tenth of that, so it approaches the limit it has just met
 * slowly instead of meeting it again every few minutes. With a steady limit L that means
 * about one 429 every 9·L answered requests (1.2·L back up to 80 %, 8·L over the last
 * fifth; some ten minutes at L = 6), rather than one per 2·L; with no limit met below
 * MAX_PER_MIN, none at all.
 *
 * The budget is a token bucket at that rate: a poll may send when a whole token is there
 * (TOKEN_CAPACITY caps what an idle spell saves up, so there is no burst after one). Every
 * request the provider makes takes a token — so the total stays within the budget — but not
 * every request waits for one:
 *
 *  - background requests (the position polls: the view's point query, the circles, the type
 *    rotation, the military list) wait for a token, for the Retry-After, and for any
 *    foreground request in progress;
 *  - foreground requests (a selected aircraft's route or trace — the operator is looking at
 *    a panel that says "Looking up") go at once and borrow the token, down to MAX_DEBT. The
 *    polls after them pay it back by waiting. A selection never queues behind the rotation,
 *    and while one is in progress (including its one retry) no poll takes the slot the host's
 *    own pacing would give it.
 *
 * A poll that may not send answers from what the provider already holds (index.ts), which
 * costs adsb.lol nothing.
 */
export const START_PER_MIN = 4;
export const MIN_PER_MIN = 0.5;
export const MAX_PER_MIN = 6;
export const INCREASE_PER_SUCCESS = 0.25;
/** Above CEILING_APPROACH × the rate of the last 429, the increase is this fraction of the normal one. */
export const CEILING_APPROACH = 0.8;
export const CEILING_INCREASE_FACTOR = 0.1;
export const CEILING_MEMORY_MS = 30 * 60_000;
export const TOKEN_CAPACITY = 1.5;
export const MAX_DEBT = -2;
/**
 * The host's own pacing after a 429 (packages/core/src/http.ts, PACE_*): it keeps a gap
 * between requests to the host, double the gap that was refused (at least a second, at most
 * two minutes), narrowed by 5 % with each answer, and refuses a request more than two
 * seconds early. The budget keeps the same gap for its polls — it climbs faster than 5 % an
 * answer at low rates, and a poll the host refuses locally is a failed poll in Source Health
 * that adsb.lol never saw.
 */
const HOST_PACE_MIN_MS = 1_000;
const HOST_PACE_MAX_MS = 120_000;
const HOST_PACE_RELAX = 0.95;
const HOST_PACE_SLACK_MS = 2_000;
/** A Retry-After longer than this is not believed (the host caps it the same way). */
const MAX_RETRY_AFTER_MS = 15 * 60_000;
/** A 429 without a Retry-After waits this long (the host's own default). */
const DEFAULT_RETRY_AFTER_MS = 45_000;

export interface BudgetSummary {
  /** Requests a minute the budget currently allows. */
  perMinute: number;
  /** Requests sent (answered or not) and 429s received since the provider started. */
  sent: number;
  rateLimited: number;
  /** Polls that answered from memory because the budget said wait. */
  withheld: number;
  /** Milliseconds until adsb.lol's Retry-After has passed (0 when it has). */
  waitMs: number;
  /** When the last 429 arrived (epoch ms), if one has. */
  lastRateLimitedAtMs: number | undefined;
  /** The gap the host keeps between requests since a 429, while it applies. */
  hostGapMs: number | undefined;
}

export class RequestBudget {
  private rate: number;
  private tokens = 1;
  private refilledAt: number | undefined;
  private notBefore = 0;
  private foreground = 0;
  private ceiling: { rate: number; atMs: number } | undefined;
  private sent = 0;
  private limited = 0;
  private withheldPolls = 0;
  private lastLimitedAt: number | undefined;
  private lastSentAt: number | undefined;
  /** The gap between the last request and the one before it. */
  private lastGapMs: number | undefined;
  /** The host's pacing gap as the host keeps it (HOST_PACE_*), while it applies. */
  private hostGapMs: number | undefined;

  constructor(
    private readonly opts: { startPerMin?: number; minPerMin?: number; maxPerMin?: number; enabled?: boolean } = {},
  ) {
    this.rate = opts.startPerMin ?? START_PER_MIN;
  }

  get perMinute(): number {
    return this.rate;
  }

  private refill(nowMs: number): void {
    if (this.refilledAt !== undefined && nowMs > this.refilledAt)
      this.tokens = Math.min(TOKEN_CAPACITY, this.tokens + ((nowMs - this.refilledAt) * this.rate) / 60_000);
    this.refilledAt = Math.max(nowMs, this.refilledAt ?? nowMs);
  }

  /**
   * Whether a background request may go now. False while a foreground request is in
   * progress, before adsb.lol's Retry-After, or without a whole token. Counts the refusal.
   */
  mayPoll(nowMs: number): boolean {
    if (this.opts.enabled === false) return true;
    this.refill(nowMs);
    const paced =
      this.hostGapMs !== undefined &&
      this.lastSentAt !== undefined &&
      nowMs - this.lastSentAt < this.hostGapMs - HOST_PACE_SLACK_MS;
    const ok = this.foreground === 0 && nowMs >= this.notBefore && this.tokens >= 1 && !paced;
    if (!ok) this.withheldPolls++;
    return ok;
  }

  /** A request is being sent (background or foreground): it takes a token. */
  sending(nowMs: number): void {
    this.refill(nowMs);
    this.lastGapMs = this.lastSentAt === undefined ? undefined : nowMs - this.lastSentAt;
    this.lastSentAt = nowMs;
    this.sent++;
    this.tokens = Math.max(MAX_DEBT, this.tokens - 1);
  }

  /** A foreground lookup starts; background polls wait until every one has ended. */
  beginForeground(): void {
    this.foreground++;
  }

  endForeground(): void {
    this.foreground = Math.max(0, this.foreground - 1);
  }

  /** adsb.lol answered (200 or 304): creep up. */
  answered(nowMs: number): void {
    if (this.ceiling && nowMs - this.ceiling.atMs > CEILING_MEMORY_MS) this.ceiling = undefined;
    const near = this.ceiling !== undefined && this.rate >= this.ceiling.rate * CEILING_APPROACH;
    const step = INCREASE_PER_SUCCESS * (near ? CEILING_INCREASE_FACTOR : 1);
    this.rate = Math.min(this.opts.maxPerMin ?? MAX_PER_MIN, this.rate + step);
    if (this.hostGapMs !== undefined) {
      this.hostGapMs *= HOST_PACE_RELAX;
      if (this.hostGapMs < HOST_PACE_MIN_MS) this.hostGapMs = undefined;
    }
  }

  /**
   * A request was refused for rate. `fromAdsbLol` is a 429 from the service; otherwise the
   * host's own limiter or pacing refused it before sending. Either way nothing goes before
   * `retryAfterMs`. Only a 429 that arrived while the budget believed sending was allowed
   * halves the rate: the host repeats the 429's status on requests it refuses during the
   * same Retry-After, and one limit met is one decrease.
   */
  refused(nowMs: number, fromAdsbLol: boolean, retryAfterMs: number | undefined): void {
    const wait = Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryAfterMs ?? DEFAULT_RETRY_AFTER_MS));
    const fresh = fromAdsbLol && nowMs >= this.notBefore;
    this.notBefore = Math.max(this.notBefore, nowMs + wait);
    if (!fresh) return;
    this.limited++;
    this.lastLimitedAt = nowMs;
    this.ceiling = { rate: this.rate, atMs: nowMs };
    this.rate = Math.max(this.opts.minPerMin ?? MIN_PER_MIN, this.rate / 2);
    this.tokens = Math.min(this.tokens, 0);
    const from = Math.max(this.hostGapMs ?? 0, this.lastGapMs ?? 0, HOST_PACE_MIN_MS);
    this.hostGapMs = Math.min(HOST_PACE_MAX_MS, from * 2);
  }

  summary(nowMs: number): BudgetSummary {
    return {
      perMinute: this.rate,
      sent: this.sent,
      rateLimited: this.limited,
      withheld: this.withheldPolls,
      waitMs: Math.max(0, this.notBefore - nowMs),
      lastRateLimitedAtMs: this.lastLimitedAt,
      hostGapMs: this.hostGapMs,
    };
  }
}
