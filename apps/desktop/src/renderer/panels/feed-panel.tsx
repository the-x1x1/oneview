import { useMemo, useState, type ReactNode } from 'react';
import type { SeverityClass } from '@worldview/world-model';
import { SEVERITY_ORDER } from '@worldview/world-model';
import type { FeedItem } from '@worldview/ipc-contract';
import { EmptyState, Panel, StatusBadge, VirtualList, formatAgo, formatObjectType, type VirtualListProps } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { useNow } from '../hooks/use-now.js';

const FeedList = VirtualList as (props: VirtualListProps<FeedItem>) => ReactNode;
const SEVERITIES: SeverityClass[] = ['INFO', 'MINOR', 'MODERATE', 'SEVERE', 'EXTREME'];

/** World feed (directive §66): newest first, severity filter, click flies the map to the event/object. */
export function FeedPanel() {
  const { feed, world } = useAppState();
  const actions = useActions();
  const nowMs = useNow(5000);
  const [minSeverity, setMinSeverity] = useState<SeverityClass>('INFO');
  const items = useMemo(() => feed.items.filter((i) => SEVERITY_ORDER[i.severity] >= SEVERITY_ORDER[minSeverity]), [feed.items, minSeverity]);

  const open = (item: FeedItem) => {
    if (item.eventId) { void actions.select(item.eventId, { kind: 'event', fly: true }); return; }
    if (item.objectId) { void actions.select(item.objectId, { kind: 'object', fly: true }); return; }
    if (item.position) void actions.flyTo({ position: item.position, zoom: 7 });
  };

  const filter = (
    <label className="wv-feed__filter">
      <span className="wv-visually-hidden">Minimum severity</span>
      <select className="wv-select" value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as SeverityClass)}>
        {SEVERITIES.map((s) => <option key={s} value={s}>{s === 'INFO' ? 'All severities' : `${s.charAt(0)}${s.slice(1).toLowerCase()} and above`}</option>)}
      </select>
    </label>
  );

  return (
    <Panel title="World feed" subtitle={`${items.length} items${feed.unread ? ` · ${feed.unread} new` : ''}`} actions={filter} flush>
      <FeedList
        items={items}
        itemHeight={56}
        label="World feed"
        getKey={(i) => i.id}
        selectedKey={items.find((i) => i.eventId === world.selectedId || i.objectId === world.selectedId)?.id ?? null}
        onSelect={open}
        emptyState={<EmptyState compact icon="list" title="No feed items" description={minSeverity === 'INFO' ? 'Events appear here as sources report them.' : 'Nothing at this severity yet — lower the filter to see more.'} />}
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
