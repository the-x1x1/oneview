import { useMemo, type KeyboardEvent } from 'react';
import { Icon, IconButton, type IconName } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { OVERVIEW_LAYERS, OVERVIEW_LENS_ID, layerCounts } from '../overview-layers.js';

const LENS_ICON: Record<string, IconName> = {
  overview: 'globe',
  aviation: 'aircraft',
  maritime: 'vessel',
  space: 'satellite',
  weather: 'weather',
  disasters: 'earthquake',
  transportation: 'transit',
  infrastructure: 'infrastructure',
  environment: 'leaf',
};

/**
 * Left rail (directive §53/§56). The Overview comes first, with every category nested under
 * it as a switch: turn on Aviation and Disasters and the globe shows exactly those, at once.
 * The category lenses used to be separate views, one at a time, each re-subscribing to its
 * own types; now they are layers of one view. Saved lenses of the operator's own follow as
 * before, one at a time. Arrow keys move between rows; Space or Enter acts on the focused one.
 */
export function LensRail() {
  const { lenses, ui, session, world } = useAppState();
  const actions = useActions();
  const collapsed = ui.railCollapsed;
  const hidden = session.settings?.hiddenLayers ?? [];
  const overviewActive = lenses.activeId === OVERVIEW_LENS_ID;
  const saved = lenses.lenses.filter((l) => !l.builtIn);
  const counts = useMemo(() => layerCounts(world.objects.values()), [world.objects]);
  const shownCount = OVERVIEW_LAYERS.filter((l) => !hidden.includes(l.id)).length;
  const allState: boolean | 'mixed' = shownCount === OVERVIEW_LAYERS.length ? true : shownCount === 0 ? false : 'mixed';

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-rail-row]')];
    const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next = idx;
    if (e.key === 'ArrowDown') next = (idx + 1) % rows.length;
    else if (e.key === 'ArrowUp') next = (idx - 1 + rows.length) % rows.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else return;
    e.preventDefault();
    rows[next]?.focus();
  };

  return (
    <nav className={`wv-lensrail${collapsed ? ' wv-lensrail--collapsed' : ''}`} aria-label="Lenses and layers">
      <div className="wv-lensrail__list" onKeyDown={onKeyDown}>
        <div className="wv-lensrail__overview">
          <button
            type="button"
            data-rail-row
            className={`wv-lensrail__item${overviewActive ? ' wv-lensrail__item--active' : ''}`}
            aria-current={overviewActive ? 'true' : undefined}
            title="Overview — everything significant; switch categories below"
            onClick={() => void actions.setLens(OVERVIEW_LENS_ID)}
          >
            <Icon name="globe" size={18} />
            <span className={collapsed ? 'wv-visually-hidden' : 'wv-lensrail__label'}>Overview</span>
          </button>
          {collapsed ? null : (
            <button
              type="button"
              role="checkbox"
              data-rail-row
              className="wv-lensrail__all"
              aria-checked={allState}
              aria-label={allState === true ? 'Hide every layer' : 'Show every layer'}
              title={allState === true ? 'Hide every layer' : 'Show every layer'}
              onClick={() => void actions.setAllLayersVisible(allState !== true)}
            >
              <span className="wv-lensrail__track" aria-hidden="true">
                <span className="wv-lensrail__thumb" />
              </span>
            </button>
          )}
        </div>
        <ul className="wv-lensrail__layers" aria-label="Overview layers">
          {OVERVIEW_LAYERS.map((layer) => {
            const on = !hidden.includes(layer.id);
            const count = counts[layer.id] ?? 0;
            return (
              <li key={layer.id}>
                <button
                  type="button"
                  role="switch"
                  data-rail-row
                  aria-checked={on}
                  className={`wv-lensrail__layer${on ? ' wv-lensrail__layer--on' : ''}${overviewActive ? '' : ' wv-lensrail__layer--idle'}`}
                  title={`${layer.name}: ${on ? 'shown' : 'hidden'} — ${count.toLocaleString()} on hand`}
                  onClick={() => void actions.setLayerVisible(layer.id, !on)}
                >
                  <Icon name={LENS_ICON[layer.id] ?? 'layers'} size={16} />
                  <span className={collapsed ? 'wv-visually-hidden' : 'wv-lensrail__label'}>{layer.name}</span>
                  {collapsed ? null : (
                    <>
                      <span className="wv-lensrail__count wv-num">{count ? count.toLocaleString() : ''}</span>
                      <span className="wv-lensrail__track" aria-hidden="true">
                        <span className="wv-lensrail__thumb" />
                      </span>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {saved.length ? (
          <div role="radiogroup" aria-label="Saved lenses" className="wv-lensrail__saved">
            {saved.map((lens) => {
              const active = lens.id === lenses.activeId;
              return (
                <button
                  key={lens.id}
                  type="button"
                  role="radio"
                  data-rail-row
                  aria-checked={active}
                  className={`wv-lensrail__item${active ? ' wv-lensrail__item--active' : ''}`}
                  title={lens.description ? `${lens.name} — ${lens.description}` : lens.name}
                  onClick={() => void actions.setLens(lens.id)}
                >
                  <Icon name="layers" size={18} />
                  <span className={collapsed ? 'wv-visually-hidden' : 'wv-lensrail__label'}>{lens.name}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="wv-lensrail__footer">
        <IconButton
          icon={collapsed ? 'chevronRight' : 'chevronLeft'}
          label={collapsed ? 'Expand lens rail' : 'Collapse lens rail'}
          size="sm"
          onClick={() => actions.setRailCollapsed(!collapsed)}
        />
      </div>
    </nav>
  );
}
