import type { KeyboardEvent } from 'react';
import { Icon, IconButton, type IconName } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';

const LENS_ICON: Record<string, IconName> = {
  overview: 'globe', aviation: 'aircraft', maritime: 'vessel', space: 'satellite', weather: 'weather', disasters: 'earthquake', transportation: 'transit', infrastructure: 'infrastructure', environment: 'leaf',
};

/** Left lens rail (directive §53/§56): one button per lens, radio semantics, arrow-key navigation. */
export function LensRail() {
  const { lenses, ui } = useAppState();
  const actions = useActions();
  const collapsed = ui.railCollapsed;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = lenses.lenses.findIndex((l) => l.id === lenses.activeId);
    let next = idx;
    if (e.key === 'ArrowDown') next = (idx + 1) % lenses.lenses.length;
    else if (e.key === 'ArrowUp') next = (idx - 1 + lenses.lenses.length) % lenses.lenses.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = lenses.lenses.length - 1;
    else return;
    e.preventDefault();
    const lens = lenses.lenses[next];
    if (lens) {
      void actions.setLens(lens.id);
      (e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next])?.focus();
    }
  };

  return (
    <nav className={`wv-lensrail${collapsed ? ' wv-lensrail--collapsed' : ''}`} aria-label="Lenses">
      <div role="radiogroup" aria-label="Active lens" className="wv-lensrail__list" onKeyDown={onKeyDown}>
        {lenses.lenses.map((lens) => {
          const active = lens.id === lenses.activeId;
          return (
            <button
              key={lens.id}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              className={`wv-lensrail__item${active ? ' wv-lensrail__item--active' : ''}`}
              title={lens.description ? `${lens.name} — ${lens.description}` : lens.name}
              onClick={() => void actions.setLens(lens.id)}
            >
              <Icon name={LENS_ICON[lens.id] ?? 'layers'} size={18} />
              <span className={collapsed ? 'wv-visually-hidden' : 'wv-lensrail__label'}>{lens.name}</span>
            </button>
          );
        })}
      </div>
      <div className="wv-lensrail__footer">
        <IconButton icon={collapsed ? 'chevronRight' : 'chevronLeft'} label={collapsed ? 'Expand lens rail' : 'Collapse lens rail'} size="sm" onClick={() => actions.setRailCollapsed(!collapsed)} />
      </div>
    </nav>
  );
}
