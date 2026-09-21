/**
 * Windowing math for fixed-height rows. Pure; tested without a DOM.
 */
export interface VirtualWindow {
  /** First rendered index (inclusive). */
  start: number;
  /** Last rendered index (exclusive). */
  end: number;
  /** Total scrollable height in px. */
  totalHeight: number;
  /** Translate for the rendered slice. */
  offsetY: number;
}

export interface VirtualInput {
  itemCount: number;
  itemHeight: number;
  viewportHeight: number;
  scrollTop: number;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number | undefined;
}

export function computeWindow({ itemCount, itemHeight, viewportHeight, scrollTop, overscan = 4 }: VirtualInput): VirtualWindow {
  if (itemCount <= 0 || itemHeight <= 0) return { start: 0, end: 0, totalHeight: 0, offsetY: 0 };
  const totalHeight = itemCount * itemHeight;
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  const top = Math.min(Math.max(0, scrollTop), maxScroll);
  const first = Math.floor(top / itemHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / itemHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(itemCount, first + visible + overscan);
  return { start, end, totalHeight, offsetY: start * itemHeight };
}

/** scrollTop that brings `index` into view with the least movement (`'nearest'`), or aligned to the top. */
export function scrollTopForIndex(index: number, itemHeight: number, viewportHeight: number, currentScrollTop: number, align: 'nearest' | 'start' = 'nearest'): number {
  const itemTop = index * itemHeight;
  const itemBottom = itemTop + itemHeight;
  if (align === 'start') return itemTop;
  if (itemTop < currentScrollTop) return itemTop;
  if (itemBottom > currentScrollTop + viewportHeight) return itemBottom - viewportHeight;
  return currentScrollTop;
}

/** Keyboard navigation over list indices: returns the next active index or the current one. */
export function moveActiveIndex(current: number, count: number, key: string, pageSize = 10): number {
  if (count <= 0) return -1;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  switch (key) {
    case 'ArrowDown': return clamp(current + 1);
    case 'ArrowUp': return clamp(current < 0 ? 0 : current - 1);
    case 'PageDown': return clamp(current + pageSize);
    case 'PageUp': return clamp(current - pageSize);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return current;
  }
}
