import { useMemo } from 'react';
import { lensById } from '@worldview/render-core';
import { Tabs, type TabItem } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import type { ContextTab } from '../store/types.js';
import { SelectionPanel } from '../panels/selection-panel.js';
import { SourcesPanel } from '../panels/sources-panel.js';
import { TimelinePanel } from '../panels/timeline-panel.js';
import { RelatedPanel } from '../panels/related-panel.js';
import { FeedPanel } from '../panels/feed-panel.js';
import { ChangesPanel } from '../panels/changes-panel.js';
import { CollectionsPanel } from '../panels/collections-panel.js';
import { WatchZonesPanel } from '../panels/watchzones-panel.js';

const BASE_TABS: ContextTab[] = ['selection', 'sources', 'timeline', 'related'];
const OPTIONAL_TABS: ContextTab[] = ['feed', 'changes', 'collections', 'watchzones'];

/** Tabs shown = the four fixed tabs + lens-visible panels + tabs the user opened explicitly. Exported for tests. */
export function visibleTabs(lensPanels: ReadonlyArray<string>, pinned: ReadonlyArray<ContextTab>): ContextTab[] {
  return [...BASE_TABS, ...OPTIONAL_TABS.filter((t) => lensPanels.includes(t) || pinned.includes(t))];
}

/** Right context rail (directive §53): Selection / Sources / Timeline / Related + lens-visible Feed, Collections, Watch zones. */
export function ContextRail() {
  const { ui, lenses, feed, sources, world, collections, watchzones } = useAppState();
  const actions = useActions();
  const lens = lensById(lenses.activeId, lenses.lenses);
  const tabs = useMemo(() => visibleTabs(lens?.visiblePanels ?? [], ui.pinnedTabs), [lens, ui.pinnedTabs]);
  const active: ContextTab = tabs.includes(ui.contextTab) ? ui.contextTab : 'selection';

  const degraded = sources.entries.filter(
    (e) => e.enabled && ['OFFLINE', 'ERROR', 'AUTH_REQUIRED', 'DEGRADED', 'RATE_LIMITED'].includes(e.health.status),
  ).length;
  const items: TabItem[] = tabs.map((t) => {
    switch (t) {
      case 'selection':
        return { id: t, label: 'Selection', icon: 'target', badge: world.selectedId ? 1 : undefined };
      case 'sources':
        return { id: t, label: 'Sources', icon: 'database', badge: degraded || undefined };
      case 'timeline':
        return { id: t, label: 'Timeline', icon: 'clock' };
      case 'related':
        return {
          id: t,
          label: 'Related',
          icon: 'link',
          badge: world.related.objects.length + world.related.events.length || undefined,
        };
      case 'feed':
        return { id: t, label: 'Feed', icon: 'list', badge: feed.unread || undefined };
      case 'changes':
        return { id: t, label: 'What changed', icon: 'activity' };
      case 'collections':
        return { id: t, label: 'Collections', icon: 'bookmark', badge: collections.collections.length || undefined };
      case 'watchzones':
        return { id: t, label: 'Watch zones', icon: 'target', badge: watchzones.zones.length || undefined };
    }
  });

  return (
    <aside className="wv-context" aria-label="Context">
      <Tabs
        items={items}
        activeId={active}
        onChange={(id) => actions.setContextTab(id as ContextTab)}
        label="Context panels"
        compact
      >
        {active === 'selection' ? <SelectionPanel /> : null}
        {active === 'sources' ? <SourcesPanel /> : null}
        {active === 'timeline' ? <TimelinePanel /> : null}
        {active === 'related' ? <RelatedPanel /> : null}
        {active === 'feed' ? <FeedPanel /> : null}
        {active === 'changes' ? <ChangesPanel /> : null}
        {active === 'collections' ? <CollectionsPanel /> : null}
        {active === 'watchzones' ? <WatchZonesPanel /> : null}
      </Tabs>
    </aside>
  );
}
