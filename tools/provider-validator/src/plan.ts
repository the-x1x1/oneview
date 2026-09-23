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
  /** Manifest ids this directory may host when they differ from the directory name (e.g. providers/firms → `nasa-firms`, providers/cctv-public → `public-cameras`). */
  aliases?: string[];
  /**
   * Transport profile. `network` (the default for http/websocket transports) runs the
   * timeout/rate-limit/auth scenarios, which assume the provider issues HTTP requests.
   * `local` is for providers that never touch the network (filesystem/local-process/
   * hardware): those scenarios are skipped and the Offline check instead asserts the
   * provider keeps answering with no HTTP traffic. Filesystem transports default to
   * `local`; a local-process transport that talks to a loopback service (readsb) stays
   * `network` and its Offline check is skipped, because the fixture HTTP layer cannot
   * model "loopback still reachable while the internet is down".
   */
  profile?: 'network' | 'local';
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
  /**
   * Local-access doubles for filesystem / local-process transports (ProviderContext.local).
   * `files` are served by `readGrantedFile` in the normal scenario; for filesystem transports the
   * empty/stale/malformed scenarios are served from the matching `fixtures.*` responder instead
   * (its `body` is the file content, `error: 'timeout'` becomes a TIMEOUT read).
   */
  local?: {
    files?: Record<string, Uint8Array | string>;
    /** Endpoints `probeLocal` reports reachable (url → HTTP status). */
    reachable?: Record<string, number>;
  };
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
  /** For subscribe-based providers: drive the fixture socket, or the fixture line stream. */
  subscription?: {
    /** WebSocket messages to feed after open; each is a raw frame the provider should normalize. */
    frames?: Array<string | Uint8Array>;
    /** Local line-stream providers (`local.openLineStream`): lines to feed the first stream opened. */
    lines?: string[];
    minObservations: number;
  };
}

export function definePlan(plan: ProviderTestPlan): ProviderTestPlan {
  return plan;
}
