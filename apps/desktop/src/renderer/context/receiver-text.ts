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

/** As providers/meshtastic-local OWN_FIX_FRESH_SECONDS (the renderer does not import providers). */
const OWN_FIX_FRESH_MS = 300_000;

/**
 * "This computer's GPS: fix (3D, 9 satellites) 40 s old, ±3.6 m" for the Meshtastic node plugged
 * into this computer (`payload.ownFix`), worked out at `nowMs` so an old fix reads STALE however
 * long the panel stays open. Undefined for anything else, a neighbour's node included.
 */
export function ownFixText(properties: Record<string, JsonValue>, nowMs: number): string | undefined {
  if (properties['thisNode'] !== true) return undefined;
  const f = properties['ownFix'];
  if (!f || typeof f !== 'object' || Array.isArray(f)) return undefined;
  const fix = f as Record<string, JsonValue>;
  if (fix['kind'] === 'set-by-hand') return 'Fixed position set on the node (not GPS)';
  if (fix['kind'] !== 'gps') return undefined;
  const at = typeof fix['fixAt'] === 'string' ? Date.parse(fix['fixAt']) : NaN;
  const detail = [
    fix['fixType'] === '3D' || fix['fixType'] === '2D' ? fix['fixType'] : undefined,
    typeof fix['satellites'] === 'number' ? `${fix['satellites']} satellites` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  const acc0 =
    typeof fix['accuracyM'] === 'number' && Number.isFinite(fix['accuracyM']) ? `, ±${fix['accuracyM']} m` : '';
  // A fix dated ahead of this computer's clock has no age that can be told: never "0 s old".
  if (fix['clockAhead'] === true || (Number.isFinite(at) && at > nowMs + OWN_FIX_FRESH_MS))
    return `This computer's GPS: fix of unknown age${detail ? ` (${detail})` : ''} — its time is ahead of this computer's clock${acc0}`;
  const age = Number.isFinite(at) ? Math.max(0, nowMs - at) : undefined;
  const stale = age === undefined || age > OWN_FIX_FRESH_MS;
  const ageText =
    age === undefined
      ? ''
      : age < 90_000
        ? ` ${Math.round(age / 1000)} s old`
        : age < 90 * 60_000
          ? ` ${Math.round(age / 60_000)} min old`
          : ` ${Math.round(age / 3_600_000)} h old`;
  const acc =
    typeof fix['accuracyM'] === 'number' && Number.isFinite(fix['accuracyM']) ? `, ±${fix['accuracyM']} m` : '';
  return `This computer's GPS: ${stale ? 'STALE fix' : 'fix'}${detail ? ` (${detail})` : ''}${ageText}${acc}`;
}
