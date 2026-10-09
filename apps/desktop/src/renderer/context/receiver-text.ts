import type { JsonValue } from '@worldview/world-model';

/**
 * "Received here on 1090 MHz (readsb / dump1090 (aircraft.json))" for an object a local receiver
 * heard (providers/readsb-local RECEIVER_PROVENANCE), or undefined. Read defensively: properties
 * are data from a provider, and only a well-formed receiver record produces a line.
 */
export function receiverText(properties: Record<string, JsonValue>): string | undefined {
  const r = properties['receiver'];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const rec = r as Record<string, JsonValue>;
  if (rec['kind'] !== 'own-receiver') return undefined;
  const mhz =
    typeof rec['frequencyMHz'] === 'number' && Number.isFinite(rec['frequencyMHz']) ? rec['frequencyMHz'] : undefined;
  const decoder = typeof rec['decoder'] === 'string' ? rec['decoder'].slice(0, 80) : undefined;
  return `Received here${mhz !== undefined ? ` on ${mhz} MHz` : ''}${decoder ? ` (${decoder})` : ''}`;
}
