import { useMemo, useState, type ReactNode } from 'react';
import type { SeverityClass } from '@worldview/world-model';
import { SEVERITY_ORDER } from '@worldview/world-model';
import type { FeedItem } from '@worldview/ipc-contract';
import {
  EmptyState,
  Panel,
  StatusBadge,
  VirtualList,
  formatAgo,
  formatObjectType,
  type VirtualListProps,
} from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { useNow } from '../hooks/use-now.js';
import { rankFeed } from './feed-rank.js';

const FeedList = VirtualList as (props: VirtualListProps<FeedItem>) => ReactNode;
const SEVERITIES: SeverityClass[] = ['INFO', 'MINOR', 'MODERATE', 'SEVERE', 'EXTREME'];

/**
 * World feed (directive §66): ranked by relevance — severity, age and nearness to the view
 * (feed-rank.ts, roadmap 0.4) — or newest first; severity filter; a click flies the map to
 * the event or object.
 */
export function FeedPanel() {
  const { feed, world } = useAppState();
  const actions = useActions();
  const nowMs = useNow(5000);
  const [minSeverity, setMinSeverity] = useState<SeverityClass>('INFO');
  const [order, setOrder] = useState<'relevant' | 'newest'>('relevant');
  // The view centre moves with every pan; the ranking only needs it to the nearest degree or so.
  const centerKey = `${Math.round(world.view.center.latitude)},${Math.round(world.view.center.longitude)}`;
  const items = useMemo(() => {
    const kept = feed.items.filter((i) => SEVERITY_ORDER[i.severity] >= SEVERITY_ORDER[minSeverity]);
    if (order === 'newest') return kept;
    const [lat, lon] = centerKey.split(',').map(Number) as [number, number];
    return rankFeed(kept, nowMs, { latitude: lat, longitude: lon });
    // nowMs moves every five seconds: the ranking with it.
  }, [feed.items, minSeverity, order, centerKey, nowMs]);

  const open = (item: FeedItem) => {
    if (item.eventId) {
      void actions.select(item.eventId, { kind: 'event', fly: true });
      return;
    }
    if (item.objectId) {
      void actions.select(item.objectId, { kind: 'object', fly: true });
      return;
    }
    if (item.position) void actions.flyTo({ position: item.position, zoom: 7 });
  };

  const filter = (
    <div className="wv-feed__controls">
      <label className="wv-feed__filter">
        <span className="wv-visually-hidden">Order</span>
        <select
          className="wv-select"
          value={order}
          onChange={(e) => setOrder(e.target.value as 'relevant' | 'newest')}
          title="Relevant: severity, age and nearness to the view. Newest: by time."
        >
          <option value="relevant">Relevant</option>
          <option value="newest">Newest</option>
        </select>
      </label>
      <label className="wv-feed__filter">
        <span className="wv-visually-hidden">Minimum severity</span>
        <select
          className="wv-select"
          value={minSeverity}
          onChange={(e) => setMinSeverity(e.target.value as SeverityClass)}
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s === 'INFO' ? 'All severities' : `${s.charAt(0)}${s.slice(1).toLowerCase()} and above`}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  return (
    <Panel
      title="World feed"
      subtitle={`${items.length} items${feed.unread ? ` · ${feed.unread} new` : ''}`}
      actions={filter}
      flush
    >
      <FeedList
        items={items}
        itemHeight={56}
        label="World feed"
        getKey={(i) => i.id}
        selectedKey={items.find((i) => i.eventId === world.selectedId || i.objectId === world.selectedId)?.id ?? null}
        onSelect={open}
        emptyState={
          <EmptyState
            compact
            icon="list"
            title="No feed items"
            description={
              minSeverity === 'INFO'
                ? 'Events appear here as sources report them.'
                : 'Nothing at this severity yet — lower the filter to see more.'
            }
          />
        }
        renderItem={(item) => (
          <div className="wv-feed__item">
            <div className="wv-feed__head">
              <StatusBadge kind="severity" value={item.severity} size="sm" />
              <span className="wv-feed__type">{formatObjectType(item.type)}</span>
              {item.recorded ? <StatusBadge kind="recorded" size="sm" /> : null}
              <span className="wv-feed__age wv-num">{formatAgo(item.at, nowMs)}</span>
            </div>
            <span className="wv-feed__title wv-truncate">{item.title}</span>
            {item.subtitle ? <span className="wv-feed__subtitle wv-truncate">{item.subtitle}</span> : null}
          </div>
        )}
      />
    </Panel>
  );
}
