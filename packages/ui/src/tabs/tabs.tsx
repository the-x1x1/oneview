import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../icon/icon.js';
import type { IconName } from '../icon/glyphs.js';
import './tabs.css';

export interface TabItem {
  id: string;
  label: string;
  icon?: IconName | undefined;
  /** Small count/badge rendered after the label. */
  badge?: string | number | undefined;
  disabled?: boolean | undefined;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  /** Accessible name for the tab list. */
  label: string;
  /** Show only icons (label becomes the tooltip / accessible name). */
  compact?: boolean | undefined;
  /** Rendered as the active tab panel. */
  children?: ReactNode | undefined;
  className?: string | undefined;
}

/** Next enabled index in direction, wrapping. Exported for tests. */
export function nextTabIndex(items: ReadonlyArray<Pick<TabItem, 'disabled'>>, from: number, delta: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (!items[i]?.disabled) return i;
  }
  return from;
}

/** WAI-ARIA tabs: roving tabindex, Arrow keys/Home/End move focus and activate. */
export function Tabs({ items, activeId, onChange, label, compact, children, className }: TabsProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);

  const focusTab = (index: number) => {
    const el = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index];
    el?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = items.findIndex((t) => t.id === activeId);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = nextTabIndex(items, current, 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = nextTabIndex(items, current, -1);
    else if (e.key === 'Home') next = nextTabIndex(items, -1, 1);
    else if (e.key === 'End') next = nextTabIndex(items, 0, -1);
    if (next < 0 || next === current) return;
    e.preventDefault();
    const item = items[next];
    if (item) {
      onChange(item.id);
      focusTab(next);
    }
  };

  return (
    <div className={`wv-tabs${compact ? ' wv-tabs--compact' : ''}${className ? ` ${className}` : ''}`}>
      <div ref={listRef} role="tablist" aria-label={label} className="wv-tabs__list" onKeyDown={onKeyDown}>
        {items.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={active}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={active ? 0 : -1}
              disabled={t.disabled ?? false}
              className={`wv-tabs__tab${active ? ' wv-tabs__tab--active' : ''}`}
              title={compact ? t.label : undefined}
              onClick={() => onChange(t.id)}
            >
              {t.icon ? <Icon name={t.icon} size={15} /> : null}
              <span className={compact ? 'wv-visually-hidden' : 'wv-tabs__label'}>{t.label}</span>
              {t.badge !== undefined && t.badge !== '' && t.badge !== 0 ? (
                <span className="wv-tabs__badge wv-num">{t.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${activeId}`}
        aria-labelledby={`${baseId}-tab-${activeId}`}
        className="wv-tabs__panel"
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}
