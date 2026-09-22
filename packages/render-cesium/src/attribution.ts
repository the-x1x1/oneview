/**
 * Adapted from gods-eye-view src/data/dataCredits.js and src/maps/credits.js (MIT).
 *
 * Data attribution goes into Cesium's credit display: `onScreen` entries on the
 * globe's credit line, the rest in the expandable "Data attribution" lightbox.
 * Credits are diffed by entry id + text so re-applying the same list is a no-op.
 * The map-stack credit is separate and follows the imagery actually shown.
 */
import type { AttributionEntry } from '@worldview/render-core';
import type { CreditDisplayLike, CreditLike } from './cesium-like.js';

export type CreditFactory = (html: string, showOnScreen: boolean) => CreditLike;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Credit markup: escaped text, optionally linked (http(s) only). */
export function attributionHtml(entry: Pick<AttributionEntry, 'text' | 'url'>): string {
  const text = escapeHtml(entry.text);
  if (entry.url && /^https?:\/\//i.test(entry.url))
    return `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">${text}</a>`;
  return text;
}

export class CreditSync {
  private readonly active = new Map<string, { key: string; credit: CreditLike }>();
  constructor(
    private readonly display: CreditDisplayLike,
    private readonly createCredit: CreditFactory,
  ) {}

  apply(entries: AttributionEntry[]): { added: string[]; removed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    const wanted = new Map<string, { key: string; entry: AttributionEntry }>();
    for (const e of entries) wanted.set(e.id, { key: `${e.onScreen ? 1 : 0}|${e.text}|${e.url ?? ''}`, entry: e });
    for (const [id, cur] of this.active) {
      const w = wanted.get(id);
      if (!w || w.key !== cur.key) {
        this.display.removeStaticCredit(cur.credit);
        this.active.delete(id);
        removed.push(id);
      }
    }
    for (const [id, w] of wanted) {
      if (this.active.has(id)) continue;
      const credit = this.createCredit(attributionHtml(w.entry), w.entry.onScreen);
      this.display.addStaticCredit(credit);
      this.active.set(id, { key: w.key, credit });
      added.push(id);
    }
    return { added, removed };
  }

  get size(): number {
    return this.active.size;
  }

  dispose(): void {
    for (const { credit } of this.active.values()) this.display.removeStaticCredit(credit);
    this.active.clear();
  }
}

/** On-screen credit that follows the active map stack, including fallback. */
export function createMapCredits(
  display: CreditDisplayLike,
  createCredit: CreditFactory,
): { show(html: string | null): void; destroy(): void; readonly current: string | null } {
  let active: CreditLike | null = null;
  let markup: string | null = null;
  return {
    get current() {
      return markup;
    },
    show(html: string | null) {
      if (html === markup) return;
      if (active) display.removeStaticCredit(active);
      active = html ? createCredit(html, true) : null;
      markup = html;
      if (active) display.addStaticCredit(active);
    },
    destroy() {
      this.show(null);
    },
  };
}
