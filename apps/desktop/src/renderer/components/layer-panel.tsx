import { useMemo, useState } from 'react';
import type { GeoBounds } from '@worldview/world-model';
import { Icon, type IconName } from '@worldview/ui';
import type { SourceHealthEntry } from '@worldview/source-health';
import { useActions, useAppState } from '../store/store.js';
import { layerNotes } from '../overview-layers.js';
import {
  LAYER_GROUPS,
  compactCount,
  layerOn,
  layerTreeCounts,
  sourcesNeedingKey,
  type LayerChild,
  type LayerCount,
  type LayerGroup,
  type LayerRow,
} from '../layer-tree.js';
import type { WeatherImageryLayer } from '../weather-imagery.js';

export const LAYER_ICON: Record<string, IconName> = {
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

const NO_COUNT: LayerCount = { total: 0, inView: 0 };

/** "120 in view of 4,567 on hand", for a switch's tooltip. */
function countText(n: LayerCount): string {
  return n.total === n.inView
    ? `${n.total.toLocaleString()} on hand`
    : `${n.inView.toLocaleString()} in view of ${n.total.toLocaleString()} on hand`;
}

/** The view's bounds, rounded, so the counts are not recomputed for a pan too small to change them. */
function boundsKey(b: GeoBounds | undefined): string {
  return b ? [b.west, b.south, b.east, b.north].map((v) => v.toFixed(2)).join(',') : 'world';
}

function Counts({ n }: { n: LayerCount }) {
  if (!n.total) return <span className="wv-layers__count wv-num" />;
  return (
    <span className="wv-layers__count wv-num" aria-hidden="true">
      {compactCount(n.inView)}
      {n.inView !== n.total ? <span className="wv-layers__total">/{compactCount(n.total)}</span> : null}
    </span>
  );
}

function Track() {
  return (
    <span className="wv-lensrail__track" aria-hidden="true">
      <span className="wv-lensrail__thumb" />
    </span>
  );
}

/**
 * The Overview's layers, grouped (OSIRIS's layer panel, on WorldView's own switches): a
 * category per group with its own switch and a live count, opened to show a switch per
 * object type inside it and, under a few types, a child that narrows or adds to it. Every
 * switch writes the same hidden list the rail always used (layer-tree.ts), so the map, the
 * palette's layer commands and a saved settings file all agree.
 *
 * Counts are "in view / on hand": the view's bounds against the objects the subscription
 * holds, which reaches past the edges of the view. A source that needs a key the operator
 * has not given is listed in its category as "needs key" with a way to the setting —
 * a layer that is empty for want of a key should say so, not look quiet.
 *
 * Nothing here scrolls sideways: names are truncated, counts are compact, and the rail
 * scrolls up and down only (a standing rule for the shell).
 */
export function LayerPanel({ collapsed, overviewActive }: { collapsed: boolean; overviewActive: boolean }) {
  const { session, world, sources } = useAppState();
  const actions = useActions();
  const hidden = session.settings?.hiddenLayers ?? [];
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const key = boundsKey(world.view.bounds);
  const counts = useMemo(
    () => layerTreeCounts(world.objects.values(), world.view.bounds),
    // The bounds are read through their rounded key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [world.objects, key],
  );
  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ul className="wv-lensrail__layers" aria-label="Overview layers">
      {LAYER_GROUPS.map((group) => (
        <GroupRow
          key={group.id}
          group={group}
          on={layerOn(hidden, group.id)}
          hidden={hidden}
          counts={counts}
          collapsed={collapsed}
          idle={!overviewActive}
          expanded={!collapsed && open.has(group.id)}
          onExpand={() => toggleOpen(group.id)}
          entries={sources.entries}
          onSwitch={(id, visible) => void actions.setLayerVisible(id, visible)}
          onOpenSource={(providerId) => actions.openSource(providerId)}
        />
      ))}
    </ul>
  );
}

export function GroupRow({
  group,
  on,
  hidden,
  counts,
  collapsed,
  idle,
  expanded,
  onExpand,
  entries,
  onSwitch,
  onOpenSource,
}: {
  group: LayerGroup;
  on: boolean;
  hidden: readonly string[];
  counts: ReadonlyMap<string, LayerCount>;
  collapsed: boolean;
  idle: boolean;
  expanded: boolean;
  onExpand: () => void;
  entries: readonly SourceHealthEntry[];
  onSwitch: (id: string, visible: boolean) => void;
  onOpenSource: (providerId: string) => void;
}) {
  const n = counts.get(group.id) ?? NO_COUNT;
  const notes = on ? layerNotes(entries, group.id) : [];
  const needKey = sourcesNeedingKey(entries, group.id);
  const noteId = notes.length ? `wv-layer-note-${group.id}` : undefined;
  const listId = `wv-layer-group-${group.id}`;
  return (
    <li className="wv-layers__group">
      <div className="wv-layers__head">
        {collapsed ? null : (
          <button
            type="button"
            data-rail-row
            className="wv-layers__expand"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-label={`${expanded ? 'Close' : 'Open'} ${group.name} layers`}
            title={`${expanded ? 'Close' : 'Open'} ${group.name} layers`}
            onClick={onExpand}
          >
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
        )}
        <button
          type="button"
          role="switch"
          data-rail-row
          aria-checked={on}
          aria-describedby={noteId}
          className={`wv-lensrail__layer${on ? ' wv-lensrail__layer--on' : ''}${idle ? ' wv-lensrail__layer--idle' : ''}`}
          title={[
            `${group.name}: ${on ? 'shown' : 'hidden'} — ${countText(n)}`,
            ...notes,
            ...needKey.map((e) => `${e.name}: needs a key (Sources)`),
          ].join('\n')}
          onClick={() => onSwitch(group.id, !on)}
        >
          <Icon name={LAYER_ICON[group.id] ?? 'layers'} size={16} />
          <span className={collapsed ? 'wv-visually-hidden' : 'wv-lensrail__label'}>{group.name}</span>
          {noteId ? (
            <span id={noteId} className="wv-visually-hidden">
              {notes.join(' ')}
            </span>
          ) : null}
          {collapsed ? null : (
            <>
              {notes.length ? (
                <span className="wv-lensrail__note" aria-hidden="true">
                  <Icon name="info" size={12} />
                </span>
              ) : null}
              {needKey.length ? (
                <span className="wv-lensrail__note wv-layers__keynote" aria-hidden="true">
                  <Icon name="key" size={12} />
                </span>
              ) : null}
              <Counts n={n} />
              <Track />
            </>
          )}
        </button>
      </div>
      {expanded ? (
        <ul id={listId} className="wv-layers__rows" aria-label={`${group.name} layers`}>
          {group.layers.map((layer) => (
            <TypeRow key={layer.id} layer={layer} hidden={hidden} counts={counts} parentOn={on} onSwitch={onSwitch} />
          ))}
          {group.imagery?.length ? (
            <li className="wv-layers__subhead" aria-hidden="true">
              Map imagery
            </li>
          ) : null}
          {group.imagery?.map((img) => (
            <ImageryRow key={img.id} layer={img} on={layerOn(hidden, img.id)} parentOn={on} onSwitch={onSwitch} />
          ))}
          {needKey.map((e) => (
            <li key={e.providerId}>
              <button
                type="button"
                data-rail-row
                className="wv-layers__needkey"
                title={`${e.name} needs a key before it can show anything. Open its settings in Sources.`}
                onClick={() => onOpenSource(e.providerId)}
              >
                <Icon name="key" size={12} />
                <span className="wv-lensrail__label">{e.name}</span>
                <span className="wv-layers__badge">needs key</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TypeRow({
  layer,
  hidden,
  counts,
  parentOn,
  onSwitch,
}: {
  layer: LayerRow;
  hidden: readonly string[];
  counts: ReadonlyMap<string, LayerCount>;
  parentOn: boolean;
  onSwitch: (id: string, visible: boolean) => void;
}) {
  const on = layerOn(hidden, layer.id);
  const n = counts.get(layer.id) ?? NO_COUNT;
  // A row whose category is off is shown as inert, as its switch has nothing to act on yet;
  // it still works, and holds its state for when the category comes back.
  const inert = !parentOn;
  return (
    <li>
      <button
        type="button"
        role="switch"
        data-rail-row
        aria-checked={on}
        className={`wv-lensrail__layer wv-layers__row${on ? ' wv-lensrail__layer--on' : ''}${inert ? ' wv-layers__row--inert' : ''}`}
        title={`${layer.name}: ${on ? 'shown' : 'hidden'} — ${countText(n)}${inert ? ' (its category is off)' : ''}`}
        onClick={() => onSwitch(layer.id, !on)}
      >
        <span className="wv-lensrail__label">{layer.name}</span>
        <Counts n={n} />
        <Track />
      </button>
      {layer.children.length ? (
        <ul className="wv-layers__children" aria-label={`${layer.name} options`}>
          {layer.children.map((child) => (
            <ChildRow
              key={child.id}
              child={child}
              on={layerOn(hidden, child.id)}
              inert={inert || !on}
              n={child.counts ? (counts.get(child.id) ?? NO_COUNT) : undefined}
              onSwitch={onSwitch}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** A picture over the map (clouds, rain, radar): a switch with no count — it is not objects. */
function ImageryRow({
  layer,
  on,
  parentOn,
  onSwitch,
}: {
  layer: WeatherImageryLayer;
  on: boolean;
  parentOn: boolean;
  onSwitch: (id: string, visible: boolean) => void;
}) {
  const inert = !parentOn;
  return (
    <li>
      <button
        type="button"
        role="switch"
        data-rail-row
        aria-checked={on}
        className={`wv-lensrail__layer wv-layers__row${on ? ' wv-lensrail__layer--on' : ''}${inert ? ' wv-layers__row--inert' : ''}`}
        title={`${layer.name}: ${layer.description} — ${on ? 'shown' : 'hidden'}${inert ? ' (Weather is off)' : ''}`}
        onClick={() => onSwitch(layer.id, !on)}
      >
        <span className="wv-lensrail__label">{layer.name}</span>
        <span className="wv-layers__count wv-num" />
        <Track />
      </button>
    </li>
  );
}

function ChildRow({
  child,
  on,
  inert,
  n,
  onSwitch,
}: {
  child: LayerChild;
  on: boolean;
  inert: boolean;
  n: LayerCount | undefined;
  onSwitch: (id: string, visible: boolean) => void;
}) {
  return (
    <li className="wv-layers__child">
      <span className="wv-layers__stem" aria-hidden="true" />
      <button
        type="button"
        role="switch"
        data-rail-row
        aria-checked={on}
        className={`wv-lensrail__layer wv-layers__row${on ? ' wv-lensrail__layer--on' : ''}${inert ? ' wv-layers__row--inert' : ''}`}
        title={`${child.name}: ${child.description}${n ? ` — ${countText(n)}` : ''}${inert ? ' (the layer above is off)' : ''}`}
        onClick={() => onSwitch(child.id, !on)}
      >
        <span className="wv-lensrail__label">{child.name}</span>
        {n ? <Counts n={n} /> : null}
        <Track />
      </button>
    </li>
  );
}
