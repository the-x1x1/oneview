import type { DetailLevel } from './presentation.js';

/**
 * Adaptive render budget.
 *
 * The presenter used to be told how much it was allowed to draw by a constant — 20,000
 * features at the desktop call site, 50,000 in `presentObjects`, 100,000/200,000 in the
 * two renderers' capabilities. A constant is wrong on every machine at once: it is far
 * too much for the laptop this is supposed to run on, which spends the whole frame
 * budget building billboards it cannot composite in time, and far too little for a
 * workstation, which sits idle while objects the operator asked for are dropped on the
 * floor. Neither machine can be identified up front — GPU strings lie, and the same
 * machine is fast over open ocean and slow over a city — so the only honest input is the
 * frame rate the renderer is actually achieving.
 *
 * The governor turns that measurement into a rung on a fixed ladder (`BUDGET_LADDER`).
 * Each rung is strictly cheaper than the one above it, and the walk is deliberately
 * asymmetric: down fast, because a stuttering map is unusable now, and up slowly, because
 * the cost of climbing too eagerly is an oscillation between two rungs that looks far
 * worse than staying one rung low.
 *
 * What gets given up, and in what order, is the part worth arguing about. Detail is
 * surrendered before features are: dropping features makes objects *disappear*, which is
 * the one thing an operator must be able to trust this view not to do, while dropping
 * detail keeps every object on screen in a cheaper form (an icon becomes a marker, a
 * crowd becomes a count). Only when there is no detail left to give does the ladder
 * start cutting the feature count, and even then it stops at a floor rather than
 * emptying the screen.
 */
export interface PerformanceBudget {
  /** Hard cap on features emitted by one presentation pass. */
  maxFeatures: number;
  /** How much each rendering rule is allowed to draw (see `DetailLevel`). */
  detail: DetailLevel;
}

/**
 * Ordered best-first. Every step down must be cheaper than the step above it in at least
 * one dimension and more expensive in none — `budgetLadderIsMonotone` checks that, because
 * a ladder that steps *up* in cost on the way down would let the governor chase its own
 * tail forever.
 */
export const BUDGET_LADDER: readonly PerformanceBudget[] = [
  { detail: 0, maxFeatures: 150_000 },
  { detail: 0, maxFeatures: 60_000 },
  { detail: 1, maxFeatures: 60_000 },
  { detail: 1, maxFeatures: 25_000 },
  { detail: 2, maxFeatures: 25_000 },
  { detail: 2, maxFeatures: 8_000 },
  { detail: 2, maxFeatures: 1_500 },
];

/** True when no rung on the ladder is more expensive than the rung above it. */
export function budgetLadderIsMonotone(ladder: readonly PerformanceBudget[] = BUDGET_LADDER): boolean {
  for (let i = 1; i < ladder.length; i++) {
    const above = ladder[i - 1]!;
    const here = ladder[i]!;
    if (here.maxFeatures > above.maxFeatures) return false;
    if (here.detail < above.detail) return false;
    if (here.maxFeatures === above.maxFeatures && here.detail === above.detail) return false;
  }
  return true;
}

export interface FrameSample {
  fps: number;
  featureCount: number;
}

export interface PerformanceGovernorOptions {
  /** At or below this frame rate the view is judged unusable and the governor steps down. */
  floorFps?: number;
  /** At or above this frame rate there is headroom to spend and the governor steps up. */
  targetFps?: number;
  /** Consecutive slow samples required before stepping down. */
  slowSamples?: number;
  /** Consecutive fast samples required before stepping up, before any oscillation penalty. */
  fastSamples?: number;
  /** Extra fast samples demanded per previous failure at a rung, and the cap on that. */
  climbPenalty?: number;
  maxClimbPenalty?: number;
  /** Rung to start from before any frame has been measured. */
  initialRung?: number;
  /** Ceiling applied to every rung, normally the active renderer's `capabilities.maxFeatures`. */
  featureCeiling?: number;
  ladder?: readonly PerformanceBudget[];
}

/**
 * Frame samples arrive about once a second from each renderer, so the counters below are
 * in seconds: two slow seconds to step down, six fast ones to step back up.
 */
export class PerformanceGovernor {
  private readonly ladder: readonly PerformanceBudget[];
  private readonly floorFps: number;
  private readonly targetFps: number;
  private readonly slowSamples: number;
  private readonly fastSamples: number;
  private readonly climbPenalty: number;
  private readonly maxClimbPenalty: number;
  /** Times each rung has had to be abandoned; the cost of climbing back into it. */
  private readonly failures: number[];
  private featureCeiling: number;
  private rung: number;
  private slowRun = 0;
  private fastRun = 0;
  private lastFps: number | null = null;

  constructor(options: PerformanceGovernorOptions = {}) {
    this.ladder = options.ladder ?? BUDGET_LADDER;
    if (this.ladder.length === 0) throw new TypeError('PerformanceGovernor needs at least one budget rung');
    this.floorFps = options.floorFps ?? 24;
    this.targetFps = options.targetFps ?? 50;
    if (this.targetFps <= this.floorFps) throw new TypeError('targetFps must leave a dead band above floorFps');
    this.slowSamples = Math.max(1, options.slowSamples ?? 2);
    this.fastSamples = Math.max(1, options.fastSamples ?? 6);
    this.climbPenalty = Math.max(0, options.climbPenalty ?? 4);
    this.maxClimbPenalty = Math.max(0, options.maxClimbPenalty ?? 24);
    this.featureCeiling = options.featureCeiling ?? Number.POSITIVE_INFINITY;
    this.failures = new Array<number>(this.ladder.length).fill(0);
    // Rung 1, not rung 0: full detail from the first frame, because a capable machine
    // should never be shown a degraded world while the governor works out that it is
    // capable — but with a feature cap well short of the ceiling, so a weak one has a
    // much shorter fall. The asymmetry is deliberate; rung 0 has to be earned, rung 1
    // is the benefit of the doubt.
    this.rung = clampRung(options.initialRung ?? Math.min(1, this.ladder.length - 1), this.ladder.length);
  }

  /** The renderer that is about to be presented to; its capability caps every rung. */
  setFeatureCeiling(ceiling: number): void {
    this.featureCeiling = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : Number.POSITIVE_INFINITY;
  }

  get budget(): PerformanceBudget {
    const rung = this.ladder[this.rung]!;
    return { detail: rung.detail, maxFeatures: Math.min(rung.maxFeatures, this.featureCeiling) };
  }

  /** Current rung, for diagnostics and for the tests that assert the walk. */
  get level(): number {
    return this.rung;
  }

  get lastMeasuredFps(): number | null {
    return this.lastFps;
  }

  /** Fast samples this rung still needs before it will climb. */
  private climbThreshold(): number {
    if (this.rung === 0) return Number.POSITIVE_INFINITY;
    const penalty = Math.min(this.maxClimbPenalty, this.failures[this.rung - 1]! * this.climbPenalty);
    return this.fastSamples + penalty;
  }

  /**
   * Feed one measured second. Returns true when the budget changed, which is the caller's
   * cue to present again — a budget that changed and was never acted on is just a number.
   */
  sample(sample: FrameSample): boolean {
    if (!Number.isFinite(sample.fps) || sample.fps < 0) return false;
    this.lastFps = sample.fps;
    const before = this.rung;
    if (sample.fps <= this.floorFps) {
      this.fastRun = 0;
      // Stepping down only helps if there is something left to give up. A view holding
      // fewer features than the cheapest rung allows is slow for some other reason — an
      // imagery or terrain stall, another window on the GPU — and cutting its budget
      // would cost the operator objects while fixing nothing.
      const floorRung = this.ladder[this.ladder.length - 1]!;
      if (this.rung >= this.ladder.length - 1 || sample.featureCount <= floorRung.maxFeatures) {
        this.slowRun = 0;
        return false;
      }
      this.slowRun++;
      if (this.slowRun >= this.slowSamples) {
        this.slowRun = 0;
        // Record that this rung could not be sustained, so climbing back into it later
        // takes longer each time. Without this the governor oscillates between two rungs
        // forever on a machine that sits right on the boundary, and an operator watching
        // icons turn into markers and back every few seconds would rather it just picked one.
        this.failures[this.rung] = Math.min(this.failures[this.rung]! + 1, 1_000);
        this.rung = clampRung(this.rung + 1, this.ladder.length);
      }
    } else if (sample.fps >= this.targetFps) {
      this.slowRun = 0;
      this.fastRun++;
      if (this.fastRun >= this.climbThreshold()) {
        this.fastRun = 0;
        this.rung = clampRung(this.rung - 1, this.ladder.length);
      }
    } else {
      // The dead band between floor and target is the steady state the ladder is aiming
      // for. Decaying both runs here is what stops a single slow second inside an
      // otherwise healthy minute from eventually adding up to a step down.
      this.slowRun = 0;
      this.fastRun = 0;
    }
    return this.rung !== before;
  }

  /**
   * Forget the measurement history without moving the rung. Called when the view changes
   * enough that past frames stop predicting future ones — a renderer swap, or a resume
   * after the window was hidden and the frame counter was measuring nothing.
   */
  resetRuns(): void {
    this.slowRun = 0;
    this.fastRun = 0;
    this.lastFps = null;
  }
}

function clampRung(value: number, length: number): number {
  if (!Number.isInteger(value)) value = Math.round(value);
  return Math.max(0, Math.min(length - 1, value));
}
