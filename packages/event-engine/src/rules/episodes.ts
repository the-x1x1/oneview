import {
  classifyConfidence,
  makeEventId,
  parseObjectId,
  type JsonValue,
  type SeverityClass,
  type WorldEvent,
  type WorldObject,
} from '@worldview/world-model';
import { derivedProvenance, refsOf, shortUtc, type ObjectRule, type RuleContext } from './types.js';

/**
 * Episodes of something an object broadcasts about itself — an aircraft's emergency, a
 * distress beacon transmitting as active — for the rules that raise them
 * (aircraft-emergency.ts, distress-beacon.ts). One event per episode of one object:
 *
 *   raised    on a report that says it (`stateOf` gives a kind)
 *   follows   the object's position and when it was last heard, at most every `followMs`, and
 *             at once when the kind changes
 *   ends      on a report that says it has stopped (`'clear'`), or once the object has not been
 *             heard for `quietMs` — ended when it was last heard. Looked at whenever objects of
 *             the type report, on changes that only remove objects, and on the engine's
 *             `endQuiet()` every minute (`endsWhenQuiet`)
 *   reopens   an episode ended for quiet, when the object is heard saying it again within
 *             `reopenMs`: same event, so a source that hears an object only now and then
 *             (adsb.lol's rotating coverage, a distant AIS receiver) does not make a new event
 *             — and a new notification — each time
 *
 * Heard means a report newer than the last one counted: a source that lists an object's last
 * position again (Digitraffic keeps a vessel's for 15 minutes) does not keep it heard.
 */
export interface EpisodeRuleSpec<K extends string> {
  id: string;
  objectType: string;
  eventType: string;
  quietMs: number;
  followMs: number;
  reopenMs: number;
  /** What a report says: a kind, `'clear'` (it has stopped), or `'none'` (nothing about it: not this rule's). */
  stateOf(o: WorldObject): K | 'clear' | 'none';
  severityOf(kind: K): SeverityClass;
  titleOf(o: WorldObject, kind: K): string;
  /** The opening of the summary; "since <start>, last heard <time>." and the caveat are added. */
  summaryOf(o: WorldObject, kind: K, startAt: string): string;
  /** A closing sentence for the summary, e.g. "As broadcast: …". */
  caveat: string;
  /** Extra properties (kind, last heard and the end reason are the rule's). */
  propertiesOf?(o: WorldObject, kind: K): Record<string, JsonValue>;
  /** "Cleared at …" / "No longer transmitting as active at …". */
  clearText(at: string): string;
}

export function episodeRule<K extends string>(spec: EpisodeRuleSpec<K>): ObjectRule {
  const lastHeardOf = (e: WorldEvent) => Date.parse(String(e.properties?.['lastHeardAt'] ?? e.startAt));

  const eventFor = (id: string, o: WorldObject, kind: K, startAt: string, ctx: RuleContext): WorldEvent => {
    const properties: Record<string, JsonValue> = {
      ...(spec.propertiesOf?.(o, kind) ?? {}),
      kind,
      lastHeardAt: o.observedAt,
    };
    return {
      id,
      type: spec.eventType,
      title: spec.titleOf(o, kind),
      startAt,
      objectIds: [o.id],
      observationRefs: refsOf([o]),
      confidence: classifyConfidence(o.confidence),
      severity: spec.severityOf(kind),
      summary: `${spec.summaryOf(o, kind, startAt)} since ${shortUtc(startAt)}, last heard ${shortUtc(o.observedAt)}. ${spec.caveat}`,
      properties,
      geometry: { type: 'Point', coordinates: [o.position!.longitude, o.position!.latitude] },
      provenance: derivedProvenance([o], ctx.nowIso, refsOf([o])),
    };
  };

  const ended = (e: WorldEvent, at: string, reason: 'clear' | 'quiet'): WorldEvent => ({
    ...e,
    endAt: at,
    summary: `${e.summary} ${reason === 'clear' ? spec.clearText(at) : `No longer heard after ${shortUtc(at)}.`}`,
    properties: { ...(e.properties ?? {}), endReason: reason },
  });

  return {
    id: spec.id,
    objectTypes: [spec.objectType],
    eventTypes: [spec.eventType],
    scope: 'changed',
    endsWhenQuiet: true,
    evaluate(objects, ctx) {
      const open = new Map<string, WorldEvent>();
      const quietlyEnded = new Map<string, WorldEvent>();
      for (const e of ctx.existing(spec.eventType)) {
        const objectId = e.objectIds[0];
        if (!objectId) continue;
        if (!e.endAt) open.set(objectId, e);
        else if (e.properties?.['endReason'] === 'quiet' && ctx.now - Date.parse(e.endAt) <= spec.reopenMs) {
          const latest = quietlyEnded.get(objectId);
          if (!latest || Date.parse(latest.endAt!) < Date.parse(e.endAt)) quietlyEnded.set(objectId, e);
        }
      }
      const out: WorldEvent[] = [];
      const heard = new Set<string>();
      for (const o of objects) {
        if (!o.position) continue;
        const state = spec.stateOf(o);
        if (state === 'none') continue;
        const previous = open.get(o.id);
        const at = Date.parse(o.observedAt);
        if (previous) {
          // The same report again (or an older one): not heard anew.
          if (!(at > lastHeardOf(previous))) continue;
          heard.add(o.id);
          if (state === 'clear') out.push(ended(previous, o.observedAt, 'clear'));
          else if (previous.properties?.['kind'] !== state || at - lastHeardOf(previous) >= spec.followMs)
            out.push(eventFor(previous.id, o, state, previous.startAt, ctx));
          continue;
        }
        if (state === 'clear') continue;
        const resumed = quietlyEnded.get(o.id);
        if (resumed && at > Date.parse(resumed.endAt!)) {
          out.push(eventFor(resumed.id, o, state, resumed.startAt, ctx));
          continue;
        }
        const parsed = parseObjectId(o.id);
        if (!parsed) continue;
        const id = makeEventId(spec.eventType, parsed.namespace, `${parsed.value}-${Math.floor(at / 1000)}`);
        out.push(eventFor(id, o, state, o.observedAt, ctx));
      }
      for (const [objectId, e] of open) {
        if (heard.has(objectId)) continue;
        const last = lastHeardOf(e);
        if (ctx.now - last > spec.quietMs) out.push(ended(e, new Date(last).toISOString(), 'quiet'));
      }
      return out;
    },
  };
}
