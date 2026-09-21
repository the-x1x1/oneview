import { systemClock, type Clock, type WorldEvent, type WorldObject } from '@worldview/world-model';
import type { StateChange, WorldState } from '@worldview/state-engine';
import type { SourceHealthRegistry } from '@worldview/source-health';
import { TypedEmitter } from '@worldview/core';
import { EventStore, type UpsertOutcome } from './store.js';
import { earthquakeRule } from './rules/earthquake.js';
import { wildfireClusterRule } from './rules/wildfire-cluster.js';
import { weatherAlertRule } from './rules/weather-alert.js';
import { launchRule } from './rules/launch.js';
import { SourceStatusTracker } from './rules/source-status.js';
import type { ObjectRule, RuleContext } from './rules/types.js';

/**
 * EventEngine — runs deterministic object rules over WorldState changes (or explicit
 * batches) and keeps the EventStore. Rules never see raw provider payloads, never call
 * the network and never invent severity (ADR-010).
 */
export interface EventEngineOptions {
  clock?: Clock;
  store?: EventStore;
  /** Defaults to DEFAULT_RULES. */
  rules?: readonly ObjectRule[];
  sourceHealth?: SourceHealthRegistry;
  sourceStatusThrottleMs?: number;
  /** How long objects of 'all'-scope types are remembered when no WorldState is attached (default 7 days). */
  memoryWindowMs?: number;
}

export interface EventChange { event: WorldEvent; outcome: 'added' | 'updated' }
export interface EventBatchResult { added: WorldEvent[]; updated: WorldEvent[]; unchanged: number }

export const DEFAULT_RULES: readonly ObjectRule[] = Object.freeze([earthquakeRule, wildfireClusterRule, weatherAlertRule, launchRule]);

export class EventEngine {
  readonly store: EventStore;
  private readonly clock: Clock;
  private readonly rules: readonly ObjectRule[];
  private readonly emitter = new TypedEmitter<{ event: EventChange; batch: EventBatchResult }>();
  private readonly memory = new Map<string, Map<string, WorldObject>>();
  private readonly memoryWindowMs: number;
  private readonly sourceStatus: SourceStatusTracker;
  private state: WorldState | undefined;
  private detachState: (() => void) | undefined;
  private detachHealth: (() => void) | undefined;

  constructor(opts: EventEngineOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.store = opts.store ?? new EventStore();
    this.rules = opts.rules ?? DEFAULT_RULES;
    this.memoryWindowMs = opts.memoryWindowMs ?? 7 * 86_400_000;
    this.sourceStatus = new SourceStatusTracker(opts.sourceStatusThrottleMs);
    if (opts.sourceHealth) this.attachSourceHealth(opts.sourceHealth);
  }

  on<K extends 'event' | 'batch'>(event: K, listener: (payload: K extends 'event' ? EventChange : EventBatchResult) => void): () => void {
    return this.emitter.on(event, listener as never);
  }

  /** Consume WorldState changes. Returns a detach function. */
  attach(state: WorldState): () => void {
    this.detachState?.();
    this.state = state;
    const off = state.onChange((change) => this.onStateChange(change));
    this.detachState = () => { off(); this.state = undefined; this.detachState = undefined; };
    return this.detachState;
  }

  attachSourceHealth(registry: SourceHealthRegistry): () => void {
    this.detachHealth?.();
    const off = registry.on('change', (change) => {
      const e = this.sourceStatus.consider(change, this.clock.now());
      if (e) this.ingestEvent(e);
    });
    this.detachHealth = () => { off(); this.detachHealth = undefined; };
    return this.detachHealth;
  }

  /** Evaluate rules over explicit objects (tests, replay, demo). 'all'-scope rules also see remembered objects. */
  ingestBatch(objects: readonly WorldObject[]): EventBatchResult {
    const now = this.clock.now();
    this.remember(objects, now);
    return this.run(objects, now, this.rules);
  }

  /** Re-run every 'all'-scope rule (e.g. after expirations). */
  reevaluate(): EventBatchResult {
    return this.run([], this.clock.now(), this.rules.filter((r) => r.scope === 'all'));
  }

  /** Insert an externally produced event (watch-zone entry, source status). */
  ingestEvent(event: WorldEvent): UpsertOutcome {
    const outcome = this.store.upsert(event);
    if (outcome !== 'unchanged') this.emitter.emit('event', { event, outcome });
    return outcome;
  }

  dispose(): void {
    this.detachState?.();
    this.detachHealth?.();
    this.emitter.removeAll();
  }

  private onStateChange(change: StateChange): void {
    const state = this.state;
    if (!state) return;
    const objects: WorldObject[] = [];
    for (const id of [...change.added, ...change.updated]) {
      const o = state.get(id);
      if (o) objects.push(o);
    }
    const now = this.clock.now();
    const rules = change.removed.length > 0 ? this.rules : this.rules.filter((r) => r.scope === 'changed' || objects.some((o) => r.objectTypes.includes(o.type)));
    if (objects.length === 0 && change.removed.length === 0) return;
    this.run(objects, now, rules);
  }

  private run(objects: readonly WorldObject[], now: number, rules: readonly ObjectRule[]): EventBatchResult {
    const nowIso = new Date(now).toISOString();
    const ctx: RuleContext = { now, nowIso, existing: (type) => this.store.ofType(type) };
    const result: EventBatchResult = { added: [], updated: [], unchanged: 0 };
    for (const rule of rules) {
      const input = rule.scope === 'all' ? this.allOf(rule.objectTypes, now) : objects.filter((o) => rule.objectTypes.includes(o.type));
      // Nothing to evaluate — unless an 'all' rule still has active events that may need ending.
      if (input.length === 0 && (rule.scope === 'changed' || !this.hasActive(rule))) continue;
      const events = rule.evaluate(input, ctx);
      for (const e of events) {
        const outcome = this.store.upsert(e);
        if (outcome === 'added') result.added.push(e);
        else if (outcome === 'updated') result.updated.push(e);
        else result.unchanged++;
        if (outcome !== 'unchanged') this.emitter.emit('event', { event: e, outcome });
      }
    }
    if (result.added.length || result.updated.length) this.emitter.emit('batch', result);
    return result;
  }

  private hasActive(rule: ObjectRule): boolean {
    // 'all'-scope rules may need to end events whose objects all disappeared.
    return rule.eventTypes.some((t) => this.store.ofType(t).some((e) => !e.endAt));
  }

  private allOf(types: readonly string[], now: number): WorldObject[] {
    const out: WorldObject[] = [];
    for (const t of types) {
      if (this.state) out.push(...this.state.ofType(t));
      else {
        const mem = this.memory.get(t);
        if (mem) { this.prune(mem, now); out.push(...mem.values()); }
      }
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  private remember(objects: readonly WorldObject[], now: number): void {
    if (this.state) return; // the state is the memory
    const allTypes = new Set(this.rules.filter((r) => r.scope === 'all').flatMap((r) => [...r.objectTypes]));
    for (const o of objects) {
      if (!allTypes.has(o.type)) continue;
      let mem = this.memory.get(o.type);
      if (!mem) { mem = new Map(); this.memory.set(o.type, mem); }
      mem.set(o.id, o);
    }
    for (const mem of this.memory.values()) this.prune(mem, now);
  }

  private prune(mem: Map<string, WorldObject>, now: number): void {
    for (const [id, o] of mem) {
      const t = Date.parse(o.observedAt);
      const expired = (o.validUntil !== undefined && Date.parse(o.validUntil) < now) || (Number.isFinite(t) && now - t > this.memoryWindowMs);
      if (expired) mem.delete(id);
    }
  }
}
