import {
  EventTypes,
  ObjectTypes,
  classifyConfidence,
  makeEventId,
  parseObjectId,
  type JsonValue,
  type SeverityClass,
  type WorldEvent,
  type WorldObject,
} from '@worldview/world-model';
import {
  derivedProvenance,
  numberProp,
  refsOf,
  shortUtc,
  stringProp,
  type ObjectRule,
  type RuleContext,
} from './types.js';

/** A reading with the limits its source declares (a manifest's telemetry series, provider-sdk). */
export interface LimitedReading {
  key: string;
  name: string;
  units?: string;
  limits: { warnLow?: number; warnHigh?: number; critLow?: number; critHigh?: number };
}

/** Readings another rule already turns into events (the AQI: airQualityRule). */
export const READINGS_WITH_OWN_RULE: ReadonlySet<string> = new Set(['aqiUs']);

/**
 * How far back inside a limit a reading must come before its episode ends, as a share of the
 * limit's size (at least 0.1 in the reading's units): a value hovering at the line does not
 * open and close an event on every reading.
 */
export const READING_LIMIT_CLEAR_MARGIN = 0.02;

type Side = 'high' | 'low';

/**
 * readingLimitRule — an event while a sensor's or weather station's reading is past a limit
 * its source declares (roadmap 0.5: telemetry limits a watch zone can act on).
 *
 *   id        event:reading-limit:<namespace>:<value>.<key>-<start, epoch seconds> — one per
 *             episode of one reading at one object
 *   raised    when the reading is above warnHigh / critHigh or below warnLow / critLow; a
 *             source with no limits raises nothing, and a reading with a rule of its own (the
 *             AQI) is left to it
 *   severity  past a warning limit MINOR, past a critical one MODERATE, following the reading
 *             (a zone escalates when it rises)
 *   title     "<reading> above its limit at <name>" / "below …"
 *   ends      when the reading is back inside the warning limit by READING_LIMIT_CLEAR_MARGIN,
 *             the reading disappears, or the object is gone
 */
export function readingLimitRule(limitsFor: (object: WorldObject) => readonly LimitedReading[]): ObjectRule {
  return {
    id: 'reading-limit',
    objectTypes: [ObjectTypes.Sensor, ObjectTypes.WeatherStation],
    eventTypes: [EventTypes.ReadingLimit],
    scope: 'all',
    evaluate(objects, ctx) {
      const active = new Map<string, WorldEvent>();
      for (const e of ctx.existing(EventTypes.ReadingLimit)) {
        const key = e.properties?.['key'];
        if (!e.endAt && e.objectIds[0] && typeof key === 'string') active.set(`${e.objectIds[0]}|${key}`, e);
      }
      const out: WorldEvent[] = [];
      const seen = new Set<string>();
      for (const o of objects) {
        if (!o.position) continue;
        const parsed = parseObjectId(o.id);
        if (!parsed) continue;
        for (const reading of limitsFor(o)) {
          if (READINGS_WITH_OWN_RULE.has(reading.key)) continue;
          const slot = `${o.id}|${reading.key}`;
          const value = numberProp(o, reading.key);
          const previous = active.get(slot);
          if (value === undefined) continue;
          seen.add(slot);
          const past = pastLimit(value, reading.limits);
          if (!previous) {
            if (!past) continue;
            const startSec = Math.floor(Date.parse(o.observedAt) / 1000);
            const id = makeEventId(
              EventTypes.ReadingLimit,
              parsed.namespace,
              `${parsed.value}.${reading.key}-${startSec}`,
            );
            out.push(limitEvent(id, o, reading, value, past, undefined, ctx));
            continue;
          }
          const side = previous.properties?.['side'] === 'low' ? 'low' : 'high';
          if (backInside(value, reading.limits, side)) {
            out.push({
              ...previous,
              endAt: o.observedAt,
              summary: `${previous.summary} Back within the limit at ${formatValue(value, reading)}, ${shortUtc(o.observedAt)}.`,
            });
            continue;
          }
          const next = limitEvent(previous.id, o, reading, value, past ?? { side, level: 'warn' }, previous, ctx);
          if (!sameEvent(previous, next)) out.push(next);
        }
      }
      for (const [slot, e] of active) if (!seen.has(slot)) out.push({ ...e, endAt: ctx.nowIso });
      return out;
    },
  };
}

/** Which limit a value is past, the critical one first; undefined when inside every limit. */
export function pastLimit(
  value: number,
  limits: LimitedReading['limits'],
): { side: Side; level: 'warn' | 'crit'; limit: number } | undefined {
  if (limits.critHigh !== undefined && value > limits.critHigh)
    return { side: 'high', level: 'crit', limit: limits.critHigh };
  if (limits.critLow !== undefined && value < limits.critLow)
    return { side: 'low', level: 'crit', limit: limits.critLow };
  if (limits.warnHigh !== undefined && value > limits.warnHigh)
    return { side: 'high', level: 'warn', limit: limits.warnHigh };
  if (limits.warnLow !== undefined && value < limits.warnLow)
    return { side: 'low', level: 'warn', limit: limits.warnLow };
  return undefined;
}

function backInside(value: number, limits: LimitedReading['limits'], side: Side): boolean {
  const line = side === 'high' ? (limits.warnHigh ?? limits.critHigh) : (limits.warnLow ?? limits.critLow);
  if (line === undefined) return true;
  const margin = Math.max(0.1, Math.abs(line) * READING_LIMIT_CLEAR_MARGIN);
  return side === 'high' ? value <= line - margin : value >= line + margin;
}

function formatValue(value: number, reading: LimitedReading): string {
  const v = Math.round(value * 10) / 10;
  return `${v}${reading.units ? ` ${reading.units}` : ''}`;
}

function limitEvent(
  id: string,
  o: WorldObject,
  reading: LimitedReading,
  value: number,
  past: { side: Side; level: 'warn' | 'crit'; limit?: number },
  previous: WorldEvent | undefined,
  ctx: RuleContext,
): WorldEvent {
  const name = stringProp(o, 'name') ?? (o.type === ObjectTypes.WeatherStation ? 'weather station' : 'sensor');
  const side: Side = (previous?.properties?.['side'] as Side | undefined) ?? past.side;
  const severity: SeverityClass = past.level === 'crit' ? 'MODERATE' : 'MINOR';
  const prevPeak = previous?.properties?.['peak'];
  const peak =
    typeof prevPeak === 'number' ? (side === 'high' ? Math.max(prevPeak, value) : Math.min(prevPeak, value)) : value;
  const since = previous?.startAt ?? o.observedAt;
  const line = past.limit ?? (side === 'high' ? reading.limits.warnHigh : reading.limits.warnLow);
  const properties: Record<string, JsonValue> = { key: reading.key, value, peak, side, level: past.level };
  if (line !== undefined) properties['limit'] = line;
  const word = side === 'high' ? 'above' : 'below';
  let summary = `${reading.name} ${formatValue(value, reading)}, ${word} its ${past.level === 'crit' ? 'critical' : 'warning'} limit`;
  summary += line !== undefined ? ` of ${formatValue(line, reading)}` : '';
  summary += ` since ${shortUtc(since)}${peak !== value ? `; ${side === 'high' ? 'peak' : 'lowest'} ${formatValue(peak, reading)}` : ''}.`;
  return {
    id,
    type: EventTypes.ReadingLimit,
    title: `${reading.name} ${word} its limit at ${name}`,
    startAt: since,
    objectIds: [o.id],
    observationRefs: refsOf([o]),
    confidence: classifyConfidence(o.confidence),
    severity,
    summary,
    properties,
    geometry: { type: 'Point', coordinates: [o.position!.longitude, o.position!.latitude] },
    provenance: derivedProvenance([o], ctx.nowIso, refsOf([o])),
  };
}

function sameEvent(a: WorldEvent, b: WorldEvent): boolean {
  return (
    a.title === b.title &&
    a.severity === b.severity &&
    a.startAt === b.startAt &&
    !a.endAt &&
    a.summary === b.summary &&
    JSON.stringify(a.properties ?? {}) === JSON.stringify(b.properties ?? {})
  );
}
