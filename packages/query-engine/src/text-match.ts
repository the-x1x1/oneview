import type { WorldEvent, WorldObject } from '@worldview/world-model';

/**
 * Free-text matching for WorldQuery.text: every token must be a case-insensitive
 * substring of at least one searchable string of the object (id, id value, labels,
 * external ids from its observation references). Deterministic, no scoring here —
 * ranking lives in searchWorld.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const ISO_SUFFIX = /:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** `${providerId}:${externalId}:${observedAt}` → externalId (undefined when the id is not in that form). */
export function externalIdOf(observationId: string, providerId: string): string | undefined {
  if (!observationId.startsWith(`${providerId}:`)) return undefined;
  const rest = observationId.slice(providerId.length + 1);
  const stripped = rest.replace(ISO_SUFFIX, '');
  return stripped.length > 0 && stripped !== rest ? stripped : undefined;
}

export function objectSearchStrings(obj: WorldObject): string[] {
  const out: string[] = [obj.id];
  const lastColon = obj.id.lastIndexOf(':');
  if (lastColon >= 0 && lastColon < obj.id.length - 1) out.push(obj.id.slice(lastColon + 1));
  for (const v of Object.values(obj.labels)) if (v) out.push(v);
  for (const ref of obj.sourceRefs) {
    const ext = externalIdOf(ref.observationId, ref.providerId);
    if (ext) out.push(ext);
  }
  return out;
}

export function eventSearchStrings(event: WorldEvent): string[] {
  const out: string[] = [event.id, event.title];
  const lastColon = event.id.lastIndexOf(':');
  if (lastColon >= 0 && lastColon < event.id.length - 1) out.push(event.id.slice(lastColon + 1));
  for (const id of event.objectIds) out.push(id);
  return out;
}

export function matchesTokens(candidates: readonly string[], tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const lowered = candidates.map((c) => c.toLowerCase());
  return tokens.every((t) => lowered.some((c) => c.includes(t)));
}

export function objectMatchesText(obj: WorldObject, text: string): boolean {
  return matchesTokens(objectSearchStrings(obj), tokenize(text));
}

export function eventMatchesText(event: WorldEvent, text: string): boolean {
  return matchesTokens(eventSearchStrings(event), tokenize(text));
}
