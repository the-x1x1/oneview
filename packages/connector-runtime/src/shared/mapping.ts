import type { Observation } from '@worldview/world-model';
import type { ProviderContext } from '@worldview/provider-sdk';

/**
 * What every polling connector does with the records a response gave it once the
 * connector-specific reading is done: say where they came from, log the ones the mapping
 * refused, keep one observation per object across pages, and put the count in the health
 * message. Each connector wrote these the same way; they live here so the words an operator
 * reads in Source Health and in the log are the same whichever connector produced them.
 */

/** A response served from the host's cache (fresh or stale) is `cached`; one from the network is `live`. */
export function responseOrigin(res: { stale: boolean; fromCache: boolean }): 'live' | 'cached' {
  return res.stale || res.fromCache ? 'cached' : 'live';
}

/** One log line for the records the mapping refused, with the first three reasons as a sample. */
export function warnRejected(logger: ProviderContext['logger'], rejected: readonly { reason: string }[]): void {
  if (rejected.length)
    logger.warn('rejected records', {
      count: rejected.length,
      sample: rejected.slice(0, 3).map((r) => r.reason),
    });
}

/**
 * Add the observations whose object (`externalId`, else `id`) is not in `seen` yet to `into`,
 * marking them seen: a service that pages by offset can hand the same feature over on two
 * pages, and two observations of one object in one poll would count it twice. Returns how
 * many were added and how many were repeats, which the OGC and ArcGIS connectors use to
 * notice a service that ignores its paging parameter.
 */
export function addUnseen(
  observations: readonly Observation[],
  seen: Set<string>,
  into: Observation[],
): { added: number; repeated: number } {
  let added = 0;
  let repeated = 0;
  for (const o of observations) {
    const key = o.externalId ?? o.id;
    if (seen.has(key)) {
      repeated++;
      continue;
    }
    seen.add(key);
    into.push(o);
    added++;
  }
  return { added, repeated };
}

/** Source Health's line for a poll some of whose records the mapping refused (and, when given, filtered). */
export function rejectedMessage(rejected: number, filtered = 0): string {
  return `${rejected} record(s) rejected by the mapping on the last fetch${filtered ? `; ${filtered} filtered out` : ''}`;
}
