import type { WorldEvent } from '@worldview/world-model';

/**
 * The events an event names in its properties, as the selection panel lists them: the later
 * message that replaced an alert, the earlier ones an update replaces, the mainshock of an
 * aftershock (event-engine rules; roadmap 0.4 relationships).
 */
export interface EventLink {
  label: string;
  eventId: string;
}

const MAX_LINKS = 12;

export function eventLinks(ev: Pick<WorldEvent, 'properties'>): EventLink[] {
  const p = ev.properties ?? {};
  const out: EventLink[] = [];
  const by = p['supersededBy'];
  if (typeof by === 'string') out.push({ label: 'Replaced by a later message', eventId: by });
  const replaces = Array.isArray(p['supersedes'])
    ? p['supersedes'].filter((x): x is string => typeof x === 'string')
    : [];
  replaces.forEach((id, i) =>
    out.push({
      label: replaces.length === 1 ? 'Replaces an earlier message' : `Replaces earlier message ${i + 1}`,
      eventId: id,
    }),
  );
  const main = p['mainshockEventId'];
  if (typeof main === 'string') out.push({ label: 'Aftershock of', eventId: main });
  return out.slice(0, MAX_LINKS);
}
