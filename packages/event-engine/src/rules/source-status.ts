import { EventTypes, makeEventId, type IsoTimestamp, type JsonValue, type WorldEvent } from '@worldview/world-model';
import type { SourceHealthEvents } from '@worldview/source-health';
import { ENGINE_PROVIDER_ID, ENGINE_SOURCE_NAME } from './types.js';

/**
 * sourceStatusRule — INFO events for provider health transitions into or out of
 * OFFLINE / AUTH_REQUIRED / ERROR, throttled to one event per provider per 10 minutes.
 * The registry is the only input; nothing here touches the network.
 */
export const SOURCE_STATUS_THROTTLE_MS = 10 * 60_000;
const NOTABLE = new Set(['OFFLINE', 'AUTH_REQUIRED', 'ERROR']);

export type SourceChange = SourceHealthEvents['change'];

export function isNotableTransition(change: Pick<SourceChange, 'from' | 'to'>): boolean {
  return (NOTABLE.has(change.from) || NOTABLE.has(change.to)) && change.from !== change.to;
}

export function sourceStatusEvent(change: SourceChange, at: IsoTimestamp): WorldEvent {
  const compactAt = at.replace(/[-:.]/g, '').replace('T', 't').replace('Z', 'z');
  const message = change.entry.health.message;
  const lastError = change.entry.health.lastError;
  const properties: Record<string, JsonValue> = {
    providerId: change.providerId,
    from: change.from,
    to: change.to,
    sourceName: change.entry.name,
  };
  if (message) properties['message'] = message;
  if (lastError) properties['errorCode'] = lastError.code;
  let summary = `${change.entry.name} changed from ${describe(change.from)} to ${describe(change.to)} at ${at.slice(0, 16).replace('T', ' ')} UTC.`;
  if (lastError) summary += ` Last error: ${lastError.code}.`;
  return {
    id: makeEventId(EventTypes.SourceStatusChange, change.providerId, compactAt),
    type: EventTypes.SourceStatusChange,
    title: `${change.entry.name}: ${describe(change.to)}`,
    startAt: at,
    objectIds: [],
    observationRefs: [],
    confidence: 'HIGH',
    severity: 'INFO',
    summary,
    properties,
    provenance: { providerId: ENGINE_PROVIDER_ID, sourceName: ENGINE_SOURCE_NAME, origin: 'local', receivedAt: at },
  };
}

function describe(status: string): string {
  switch (status) {
    case 'AUTH_REQUIRED':
      return 'credentials required';
    case 'RATE_LIMITED':
      return 'rate limited';
    default:
      return status.toLowerCase();
  }
}

/** Stateful throttle: one event per provider per window. Deterministic under an injected clock. */
export class SourceStatusTracker {
  private readonly lastEmit = new Map<string, number>();
  constructor(private readonly throttleMs = SOURCE_STATUS_THROTTLE_MS) {}

  consider(change: SourceChange, now: number): WorldEvent | undefined {
    if (!isNotableTransition(change)) return undefined;
    const last = this.lastEmit.get(change.providerId);
    if (last !== undefined && now - last < this.throttleMs) return undefined;
    this.lastEmit.set(change.providerId, now);
    return sourceStatusEvent(change, new Date(now).toISOString());
  }

  reset(): void {
    this.lastEmit.clear();
  }
}
