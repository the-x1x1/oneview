import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { computeWindow, moveActiveIndex, scrollTopForIndex } from './virtual-math.js';
import './virtual-list.css';

export interface VirtualListProps<T> {
  items: ReadonlyArray<T>;
  itemHeight: number;
  /** Explicit viewport height; when omitted the list fills its container and measures itself. */
  height?: number | undefined;
  renderItem: (item: T, index: number, state: { active: boolean; selected: boolean }) => ReactNode;
  getKey: (item: T, index: number) => string;
  /** Accessible name for the listbox. */
  label: string;
  selectedKey?: string | null | undefined;
  onSelect?: ((item: T, index: number) => void) | undefined;
  /** Called on Enter/double-click (open). */
  onActivate?: ((item: T, index: number) => void) | undefined;
  overscan?: number | undefined;
  className?: string | undefined;
  emptyState?: ReactNode | undefined;
}

/**
 * Windowed listbox with roving active row (aria-activedescendant), arrow/page/home/end keys.
 * Rendering is pure on (scrollTop, viewportHeight), so the first server render shows the
 * first rows deterministically (viewport defaults to `height` or 400px).
 */
export function VirtualList<T>({
  items,
  itemHeight,
  height,
  renderItem,
  getKey,
  label,
  selectedKey,
  onSelect,
  onActivate,
  overscan,
  className,
  emptyState,
}: VirtualListProps<T>) {
  const id = useId();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [measured, setMeasured] = useState<number>(height ?? 400);
  const [active, setActive] = useState<number>(-1);

  useEffect(() => {
    if (height !== undefined || !viewportRef.current || typeof ResizeObserver === 'undefined') return;
    const el = viewportRef.current;
    const ro = new ResizeObserver(() => setMeasured(el.clientHeight));
    ro.observe(el);
    setMeasured(el.clientHeight);
    return () => ro.disconnect();
  }, [height]);

  const viewportHeight = height ?? measured;
  const win = computeWindow({ itemCount: items.length, itemHeight, viewportHeight, scrollTop, overscan });

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const next = scrollTopForIndex(index, itemHeight, viewportHeight, el.scrollTop);
      if (next !== el.scrollTop) {
        el.scrollTop = next;
        setScrollTop(next);
      }
    },
    [itemHeight, viewportHeight],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && active >= 0) {
      const it = items[active];
      if (it !== undefined) {
        e.preventDefault();
        (onActivate ?? onSelect)?.(it, active);
      }
      return;
    }
    const next = moveActiveIndex(active, items.length, e.key, Math.max(1, Math.floor(viewportHeight / itemHeight) - 1));
    if (next === active || next < 0) return;
    e.preventDefault();
    setActive(next);
    scrollToIndex(next);
    const it = items[next];
    if (it !== undefined && onSelect) onSelect(it, next);
  };

  const rows: ReactNode[] = [];
  for (let i = win.start; i < win.end; i++) {
    const item = items[i];
    if (item === undefined) continue;
    const key = getKey(item, i);
    const selected = selectedKey !== undefined && selectedKey !== null && key === selectedKey;
    rows.push(
      <div
        key={key}
        id={`${id}-row-${i}`}
        role="option"
        aria-selected={selected}
        aria-posinset={i + 1}
        aria-setsize={items.length}
        className={`wv-vlist__row${i === active ? ' wv-vlist__row--active' : ''}${selected ? ' wv-vlist__row--selected' : ''}`}
        style={{ height: `${itemHeight}px` }}
        onClick={() => {
          setActive(i);
          onSelect?.(item, i);
        }}
        onDoubleClick={() => onActivate?.(item, i)}
      >
        {renderItem(item, i, { active: i === active, selected })}
      </div>,
    );
  }

  return (
    <div
      ref={viewportRef}
      role="listbox"
      aria-label={label}
      aria-activedescendant={active >= 0 ? `${id}-row-${active}` : undefined}
      tabIndex={0}
      className={`wv-vlist${className ? ` ${className}` : ''}`}
      style={height !== undefined ? { height: `${height}px` } : undefined}
      onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
      onKeyDown={onKeyDown}
    >
      {items.length === 0 ? (
        (emptyState ?? null)
      ) : (
        <div className="wv-vlist__spacer" style={{ height: `${win.totalHeight}px` }}>
          <div className="wv-vlist__slice" style={{ transform: `translateY(${win.offsetY}px)` }}>
            {rows}
          </div>
        </div>
      )}
    </div>
  );
}
