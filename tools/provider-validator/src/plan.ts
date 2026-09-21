import type { WorldProvider, ProviderHealth } from '@worldview/provider-sdk';
import type { testing } from '@worldview/provider-sdk';
import type { Observation, JsonValue } from '@worldview/world-model';

/**
 * A provider test plan wires a provider to its fixtures so the generic contract
 * checklist (directive §97) can run without network access.
 */
export type FixtureResponder = testing.FixtureResponder;

export interface ProviderTestPlan {
  /** Directory name under providers/ (must equal manifest.id or be listed in `aliases`). */
  providerDir: string;
  create(): WorldProvider;
  /** Fixture responders keyed by scenario. `normal` is required. */
  fixtures: {
    normal: FixtureResponder;
    empty?: FixtureResponder;
    stale?: FixtureResponder;
    /** Each malformed responder must not crash the provider. */
    malformed?: FixtureResponder[];
    /** Optional second normal response (later snapshot) for merge checks. */
    update?: FixtureResponder;
  };
  /** Provider settings used for the run. */
  settings?: Record<string, JsonValue>;
  /** Credential keys to pretend are present. */
  credentials?: string[];
  /** Virtual clock start (ms). Defaults to 2026-09-21T08:05:00Z (five minutes after the fixture reference time). */
  clockStartMs?: number;
  expectations: {
    objectTypes: string[];
    minObservations: number;
    /** Deterministic object ids expected in the normal fixture (spot checks). */
    expectObjectIds?: string[];
    /** Extra assertions on the normalized batch; return a failure message or undefined. */
    verify?(observations: Observation[]): string | undefined;
    /** Extra assertions on the health object after the normal poll. */
    verifyHealth?(health: ProviderHealth): string | undefined;
  };
  /** For subscribe-based providers: drive the fixture socket. */
  subscription?: {
    /** Messages to feed after open; each is a raw frame the provider should normalize. */
    frames: Array<string | Uint8Array>;
    minObservations: number;
  };
}

export function definePlan(plan: ProviderTestPlan): ProviderTestPlan {
  return plan;
}
