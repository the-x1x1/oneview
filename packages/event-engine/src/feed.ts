import { EventTypes, SEVERITY_ORDER, type SeverityClass, type WorldEvent } from '@worldview/world-model';
import type { FeedItem } from '@worldview/ipc-contract';
import { geometryRepresentativePoint } from '@worldview/query-engine';
import { TypedEmitter } from '@worldview/core';
import { severityAtLeast } from './severity.js';

/**
 * FeedBuilder — turns events into FeedItems (ipc-contract shape).
 *
 *   relevance   severity ≥ MINOR by default; INFO only for source-status-change events
 *   dedupe      one item per event id (updates replace the item)
 *   bound       500 items, oldest dropped
 *   order       newest first (at desc, id asc); `at` is the event's startAt
 *   recorded    true when provenance.origin === 'recorded' — demo data is always labelled
 */
export interface FeedBuilderOptions {
  maxItems?: number;
  minimumSeverity?: SeverityClass;
  /** Event types admitted at INFO severity (default: source-status-change). */
  infoTypes?: readonly string[];
}

export const FEED_MAX_ITEMS = 500;

export class FeedBuilder {
  private readonly items = new Map<string, FeedItem>();
  private readonly maxItems: number;
  private readonly minimumSeverity: SeverityClass;
  private readonly infoTypes: ReadonlySet<string>;
  private readonly emitter = new TypedEmitter<{ item: FeedItem }>();

  constructor(opts: FeedBuilderOptions = {}) {
    this.maxItems = Math.max(1, opts.maxItems ?? FEED_MAX_ITEMS);
    this.minimumSeverity = opts.minimumSeverity ?? 'MINOR';
    this.infoTypes = new Set(opts.infoTypes ?? [EventTypes.SourceStatusChange]);
  }

  get size(): number { return this.items.size; }

  on(event: 'item', listener: (item: FeedItem) => void): () => void { return this.emitter.on(event, listener); }

  /** Returns the FeedItem when the event is relevant (added or replaced), otherwise undefined. */
  push(event: WorldEvent): FeedItem | undefined {
    if (!this.isRelevant(event)) { this.items.delete(event.id); return undefined; }
    const item = toFeedItem(event);
    this.items.set(event.id, item);
    this.trim();
    this.emitter.emit('item', item);
    return item;
  }

  remove(eventId: string): boolean { return this.items.delete(eventId); }

  isRelevant(event: WorldEvent): boolean {
    const severity = event.severity ?? 'INFO';
    if (this.infoTypes.has(event.type)) return true;
    return severityAtLeast(severity, this.minimumSeverity);
  }

  recent(opts: { limit?: number; minimumSeverity?: SeverityClass } = {}): FeedItem[] {
    const min = opts.minimumSeverity;
    const out = [...this.items.values()].filter((i) => !min || SEVERITY_ORDER[i.severity] >= SEVERITY_ORDER[min]);
    out.sort(compareItems);
    return out.slice(0, Math.max(0, opts.limit ?? 50));
  }

  clear(): void { this.items.clear(); }

  private trim(): void {
    if (this.items.size <= this.maxItems) return;
    const sorted = [...this.items.values()].sort(compareItems);
    for (const drop of sorted.slice(this.maxItems)) this.items.delete(drop.id);
  }
}

export function toFeedItem(event: WorldEvent): FeedItem {
  const item: FeedItem = {
    id: event.id,
    at: event.startAt,
    eventId: event.id,
    title: event.title,
    subtitle: event.summary,
    severity: event.severity ?? 'INFO',
    type: event.type,
  };
  if (event.objectIds[0]) item.objectId = event.objectIds[0];
  const p = event.geometry ? geometryRepresentativePoint(event.geometry) : undefined;
  if (p) item.position = p;
  if (event.provenance.origin === 'recorded') item.recorded = true;
  return item;
}

function compareItems(a: FeedItem, b: FeedItem): number {
  const ta = Date.parse(a.at), tb = Date.parse(b.at);
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
