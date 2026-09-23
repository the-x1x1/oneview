import type { PaletteCommand } from '@worldview/ui';
import type { ShellActions } from '../store/actions.js';
import type { RootState } from '../store/types.js';
import { OVERVIEW_LAYERS, OVERVIEW_LENS_ID } from '../overview-layers.js';

/**
 * Command palette commands (directive §134). Every command runs a real ShellAction;
 * commands whose preconditions are not met are marked `available: false` and the
 * palette omits them entirely (no dead entries). Pure builder — tested.
 */
export function buildCommands(state: RootState, actions: ShellActions): PaletteCommand[] {
  const hasSelection = state.world.selectedId !== null;
  const activeCollection = state.collections.activeId;
  const canScrubHistory = state.timeline.control.availability.some((a) => a.ranges.length > 0);
  const live = state.timeline.control.mode === 'LIVE';
  const host3D = state.ui.activeMode === '3D';
  const lastQuery = state.ui.lastQuery;

  // The categories are layers of the Overview (lens rail): the palette switches them the
  // same way instead of offering each as a separate view the rail no longer has.
  const layerIds = new Set(OVERVIEW_LAYERS.map((l) => l.id));
  const lensCommands: PaletteCommand[] = state.lenses.lenses
    .filter((l) => !layerIds.has(l.id))
    .map((l) => ({
      id: `lens.${l.id}`,
      title: `Lens: ${l.name}`,
      group: 'Lenses',
      icon: 'layers',
      keywords: ['lens', 'view', ...l.objectTypes],
      available: l.id !== state.lenses.activeId,
      run: () => actions.setLens(l.id),
    }));
  const hidden = state.session.settings?.hiddenLayers ?? [];
  const overview = state.lenses.activeId === OVERVIEW_LENS_ID;
  const layerCommands: PaletteCommand[] = OVERVIEW_LAYERS.flatMap((layer) => {
    const on = !hidden.includes(layer.id);
    const alone = on && OVERVIEW_LAYERS.every((l) => l.id === layer.id || hidden.includes(l.id));
    return [
      {
        id: `layer.${layer.id}`,
        title: `${on && overview ? 'Hide' : 'Show'} ${layer.name}`,
        group: 'Layers',
        icon: 'layers',
        keywords: ['layer', 'toggle', 'lens', layer.name.toLowerCase(), ...layer.objectTypes],
        run: () => actions.setLayerVisible(layer.id, !(on && overview)),
      },
      {
        id: `layer.${layer.id}.only`,
        title: `Show only ${layer.name}`,
        group: 'Layers',
        icon: 'layers',
        keywords: ['layer', 'only', 'solo', 'lens', layer.name.toLowerCase(), ...layer.objectTypes],
        available: !(alone && overview),
        run: () => actions.showOnlyLayer(layer.id),
      },
    ];
  });

  return [
    {
      id: 'search.focus',
      title: 'Search places, objects and events',
      group: 'Navigate',
      icon: 'search',
      shortcut: '/',
      keywords: ['find', 'go to', 'place'],
      run: () => actions.focusSearch(),
    },
    {
      id: 'view.2d',
      title: 'Switch to 2D map',
      group: 'View',
      icon: 'map2d',
      shortcut: '2',
      available: state.ui.activeMode !== '2D',
      run: () => actions.setMode('2D'),
    },
    {
      id: 'view.3d',
      title: 'Switch to 3D globe',
      group: 'View',
      icon: 'map3d',
      shortcut: '3',
      available: state.ui.supports3D && !host3D && state.ui.mode !== '3D',
      run: () => actions.setMode('3D'),
    },
    {
      id: 'view.rail',
      title: state.ui.railCollapsed ? 'Expand lens rail' : 'Collapse lens rail',
      group: 'View',
      icon: state.ui.railCollapsed ? 'chevronRight' : 'chevronLeft',
      run: () => actions.setRailCollapsed(!state.ui.railCollapsed),
    },
    ...lensCommands,
    ...layerCommands,
    {
      id: 'layer.all',
      title: 'Show every layer',
      group: 'Layers',
      icon: 'layers',
      keywords: ['layer', 'all', 'overview', 'reset'],
      available: hidden.length > 0 || !overview,
      run: () => actions.setAllLayersVisible(true),
    },
    {
      id: 'timeline.live',
      title: 'Jump to live',
      group: 'Timeline',
      icon: 'live',
      available: !live,
      run: () => actions.timeline({ type: 'jumpToLive' }),
    },
    {
      id: 'timeline.toggle',
      title: live || state.timeline.control.mode === 'REPLAY' ? 'Pause timeline' : 'Play timeline',
      group: 'Timeline',
      icon: live ? 'pause' : 'play',
      shortcut: 'Space',
      run: () => actions.timeline({ type: 'togglePlay' }),
    },
    {
      id: 'timeline.earliest',
      title: 'Go to earliest recorded time',
      group: 'Timeline',
      icon: 'history',
      available: canScrubHistory,
      run: () => {
        const first = state.timeline.control.availability
          .flatMap((a) => a.ranges)
          .sort((a, b) => a.startMs - b.startMs)[0];
        if (first) actions.timeline({ type: 'scrubTo', ms: first.startMs });
      },
    },
    {
      id: 'timeline.panel',
      title: 'Open timeline panel',
      group: 'Timeline',
      icon: 'clock',
      run: () => actions.setContextTab('timeline'),
    },
    {
      id: 'selection.clear',
      title: 'Clear selection',
      group: 'Selection',
      icon: 'close',
      shortcut: 'Esc',
      available: hasSelection,
      run: () => actions.clearSelection(),
    },
    {
      id: 'selection.fly',
      title: 'Fly to selection',
      group: 'Selection',
      icon: 'target',
      available: hasSelection,
      run: () => {
        if (state.world.selectedId)
          void actions.select(state.world.selectedId, { kind: state.world.selectedKind ?? 'object', fly: true });
      },
    },
    {
      id: 'selection.related',
      title: 'Show related items',
      group: 'Selection',
      icon: 'link',
      available: hasSelection,
      run: () => actions.setContextTab('related'),
    },
    {
      id: 'collection.add',
      title: 'Add selection to active collection',
      group: 'Collections',
      icon: 'bookmark',
      available: hasSelection && activeCollection !== null,
      run: () => actions.addSelectionToCollection(activeCollection!),
    },
    {
      id: 'collection.location',
      title: 'Add map centre to active collection',
      group: 'Collections',
      icon: 'pin',
      available: activeCollection !== null,
      run: () => actions.addLocationToCollection(activeCollection!),
    },
    {
      id: 'collection.open',
      title: 'Open collections',
      group: 'Collections',
      icon: 'bookmark',
      run: () => actions.setContextTab('collections'),
    },
    {
      id: 'zone.create',
      title: 'Create watch zone at map centre (50 km)',
      group: 'Watch zones',
      icon: 'target',
      keywords: ['alert', 'geofence'],
      run: () => actions.createCircleZoneAtCenter(50_000),
    },
    {
      id: 'zone.open',
      title: 'Open watch zones',
      group: 'Watch zones',
      icon: 'target',
      run: () => actions.setContextTab('watchzones'),
    },
    {
      id: 'feed.open',
      title: 'Open world feed',
      group: 'Feed',
      icon: 'list',
      run: () => actions.setContextTab('feed'),
    },
    {
      id: 'world.changed',
      title: 'What changed here',
      group: 'World',
      icon: 'activity',
      keywords: ['changes', 'new', 'since', 'events', 'alerts', 'history'],
      // The panel runs the check for the view and lists what it found; a toast of three
      // counts was all this used to give, with nothing to open.
      run: () => actions.setContextTab('changes'),
    },
    {
      id: 'export.geojson',
      title: 'Export visible objects as GeoJSON',
      group: 'World',
      icon: 'download',
      keywords: ['save', 'file'],
      run: () => actions.exportVisible('geojson'),
    },
    {
      id: 'export.csv',
      title: 'Export visible objects as CSV',
      group: 'World',
      icon: 'download',
      keywords: ['save', 'file', 'spreadsheet'],
      run: () => actions.exportVisible('csv'),
    },
    {
      id: 'export.query.csv',
      title: lastQuery ? `Export last search as CSV — ${lastQuery.title}` : 'Export last search as CSV',
      group: 'World',
      icon: 'download',
      keywords: ['save', 'file', 'spreadsheet', 'history', 'query', 'results'],
      available: lastQuery !== null,
      run: () => actions.exportLastQuery('csv'),
    },
    {
      id: 'export.query.geojson',
      title: lastQuery ? `Export last search as GeoJSON — ${lastQuery.title}` : 'Export last search as GeoJSON',
      group: 'World',
      icon: 'download',
      keywords: ['save', 'file', 'history', 'query', 'results'],
      available: lastQuery !== null,
      run: () => actions.exportLastQuery('geojson'),
    },
    {
      id: 'sources.open',
      title: 'Open source health',
      group: 'Sources',
      icon: 'database',
      keywords: ['providers', 'status'],
      run: () => actions.setContextTab('sources'),
    },
    ...state.sources.entries
      .filter((e) => e.enabled)
      .map<PaletteCommand>((e) => ({
        id: `sources.refresh.${e.providerId}`,
        title: `Refresh ${e.name}`,
        group: 'Sources',
        icon: 'refresh',
        keywords: ['reload', e.providerId],
        run: () => actions.refreshSource(e.providerId),
      })),
    {
      id: 'settings.open',
      title: 'Open settings',
      group: 'App',
      icon: 'settings',
      keywords: ['preferences', 'options'],
      run: () => actions.openDialog('settings'),
    },
    {
      id: 'settings.motion',
      title: state.session.settings?.reducedMotion ? 'Turn reduced motion off' : 'Turn reduced motion on',
      group: 'App',
      icon: 'settings',
      available: !!state.session.settings,
      run: async () => {
        await actions.updateSettings({ reducedMotion: !state.session.settings?.reducedMotion });
      },
    },
    {
      id: 'diagnostics.open',
      title: 'Help → Diagnostics',
      group: 'App',
      icon: 'activity',
      keywords: ['support', 'debug', 'health'],
      run: () => actions.openDialog('diagnostics'),
    },
    {
      id: 'diagnostics.export',
      title: 'Export diagnostics (redacted)',
      group: 'App',
      icon: 'download',
      run: () => actions.exportDiagnostics(),
    },
    {
      id: 'attribution.open',
      title: 'Data & attribution',
      group: 'App',
      icon: 'info',
      keywords: ['license', 'credits', 'terms'],
      run: () => actions.openDialog('attribution'),
    },
    {
      id: 'updates.check',
      title: 'Check for updates',
      group: 'App',
      icon: 'refresh',
      available: state.updater.state?.status !== 'disabled',
      run: () => actions.checkForUpdates(),
    },
    {
      id: 'offline.pack',
      title: 'Install offline pack',
      group: 'App',
      icon: 'upload',
      keywords: ['worldpack', 'offline'],
      run: async () => {
        await actions.installOfflinePack();
      },
    },
    {
      id: 'welcome.open',
      title: 'About WORLDVIEW',
      group: 'App',
      icon: 'globe',
      run: () => actions.openDialog('welcome'),
    },
  ];
}
