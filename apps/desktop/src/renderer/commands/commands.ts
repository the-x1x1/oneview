import type { PaletteCommand } from '@worldview/ui';
import type { ShellActions } from '../store/actions.js';
import type { RootState } from '../store/types.js';
import { OVERVIEW_LAYERS, OVERVIEW_LENS_ID } from '../overview-layers.js';
import { CAMERA_PREVIEWS_LAYER_ID, MILITARY_ONLY_LAYER_ID, OPT_IN_LAYER_IDS, layerOn } from '../layer-tree.js';
import { nextVisualStyle, VISUAL_STYLE_IDS } from '@worldview/render-core';
import { displaySettings, VISUAL_STYLE_NAMES } from '../store/display.js';

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
  const settings = state.session.settings;
  const display = displaySettings(settings);
  const following = state.ui.followId !== null;
  const canFollow = state.world.selectedKind === 'object' && state.world.selectedId !== null;
  const styleCommands: PaletteCommand[] = VISUAL_STYLE_IDS.map((id) => ({
    id: `view.style.${id}`,
    title: `Visual style: ${VISUAL_STYLE_NAMES[id]}`,
    group: 'View',
    icon: 'layers',
    keywords: ['style', 'look', 'filter', 'effect', VISUAL_STYLE_NAMES[id].toLowerCase()],
    available: !!settings && display.visualStyle !== id,
    run: () => actions.setVisualStyle(id),
  }));

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

  // The two opt-in children of the layer panel (layer-tree.ts), by name.
  const childCommands: PaletteCommand[] = [
    {
      id: 'layer.aircraft.military-only',
      title: layerOn(hidden, MILITARY_ONLY_LAYER_ID) ? 'Show all aircraft' : 'Show military aircraft only',
      group: 'Layers',
      icon: 'aircraft',
      keywords: ['layer', 'military', 'aircraft', 'filter'],
      available: !!settings,
      run: () => actions.setLayerVisible(MILITARY_ONLY_LAYER_ID, !layerOn(hidden, MILITARY_ONLY_LAYER_ID)),
    },
    {
      id: 'layer.camera.previews',
      title: layerOn(hidden, CAMERA_PREVIEWS_LAYER_ID) ? 'Hide live camera previews' : 'Show live camera previews',
      group: 'Layers',
      icon: 'camera',
      keywords: ['layer', 'camera', 'cctv', 'preview', 'thumbnail', 'live'],
      available: !!settings,
      run: () => actions.setLayerVisible(CAMERA_PREVIEWS_LAYER_ID, !layerOn(hidden, CAMERA_PREVIEWS_LAYER_ID)),
    },
  ];

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
      id: 'view.home',
      title: 'Go to the home view',
      group: 'Navigate',
      icon: 'globe',
      shortcut: 'Shift+H',
      keywords: ['home', 'start', 'return', 'reset view'],
      available: Boolean(settings?.home?.view),
      run: () => actions.goHome(),
    },
    {
      id: 'view.home.set',
      title: 'Make this view the home view',
      group: 'Navigate',
      icon: 'pin',
      keywords: ['home', 'set', 'save view', 'start'],
      available: !!settings,
      run: () => actions.setHomeFromView(),
    },
    {
      id: 'view.hud',
      title: display.hud ? 'Hide HUD' : 'Show HUD',
      group: 'View',
      icon: 'target',
      shortcut: 'H',
      keywords: ['heads-up', 'coordinates', 'altitude', 'heading', 'clock', 'utc', 'overlay'],
      available: !!settings,
      run: () => actions.toggleHud(),
    },
    {
      id: 'view.style.next',
      title: `Next visual style (${VISUAL_STYLE_NAMES[nextVisualStyle(display.visualStyle, 1)]})`,
      group: 'View',
      icon: 'layers',
      shortcut: 'V',
      keywords: ['style', 'look', 'night vision', 'thermal', 'crt', 'noir', 'cycle'],
      available: !!settings,
      run: () => actions.cycleVisualStyle(1),
    },
    {
      id: 'view.style.previous',
      title: `Previous visual style (${VISUAL_STYLE_NAMES[nextVisualStyle(display.visualStyle, -1)]})`,
      group: 'View',
      icon: 'layers',
      shortcut: 'Shift+V',
      keywords: ['style', 'look', 'cycle', 'back'],
      available: !!settings,
      run: () => actions.cycleVisualStyle(-1),
    },
    ...styleCommands,
    {
      id: 'view.daynight',
      title: display.dayNight ? 'Hide day and night' : 'Show day and night',
      group: 'View',
      icon: 'globe',
      shortcut: 'N',
      keywords: ['sun', 'terminator', 'night', 'shade', 'lighting'],
      available: !!settings,
      run: () => actions.toggleDayNight(),
    },
    {
      id: 'view.compare-imagery',
      title: state.ui.imageryCompare ? 'Stop comparing imagery' : 'Compare imagery',
      group: 'View',
      icon: 'layers',
      keywords: [
        'compare',
        'swipe',
        'before',
        'after',
        'split',
        'divider',
        'satellite',
        'imagery',
        'yesterday',
        'today',
      ],
      available: !!settings,
      run: () => actions.toggleImageryCompare(),
    },
    {
      id: 'view.clean',
      title: state.ui.cleanView ? 'Leave clean view' : 'Clean view (map only)',
      group: 'View',
      icon: 'map2d',
      shortcut: 'C',
      keywords: ['fullscreen', 'chrome', 'hide panels', 'presentation', 'map only'],
      run: () => actions.setCleanView(!state.ui.cleanView),
    },
    {
      id: 'camera.orbit',
      title: state.ui.orbit ? 'Stop orbiting' : 'Orbit the view',
      group: 'View',
      icon: 'refresh',
      shortcut: 'O',
      keywords: ['rotate', 'spin', 'turn', 'camera'],
      // Reduced motion: nothing turns by itself, so there is no orbit to start.
      available: state.ui.orbit || !settings?.reducedMotion,
      run: () => actions.setOrbit(!state.ui.orbit),
    },
    {
      id: 'camera.follow',
      title: following ? 'Stop following' : 'Follow selection',
      group: 'Selection',
      icon: 'target',
      shortcut: 'F',
      keywords: ['track', 'lock', 'camera', 'chase'],
      available: following || canFollow,
      run: () => actions.setFollow(!following),
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
    ...childCommands,
    {
      id: 'view.storms',
      title: 'Storms quick view',
      group: 'Layers',
      icon: 'layers',
      keywords: [
        'storm',
        'storms',
        'hurricane',
        'typhoon',
        'cyclone',
        'tornado',
        'severe',
        'weather',
        'hazard',
        'lightning',
        'radar',
      ],
      available: !!settings,
      run: () => actions.showStorms(),
    },
    {
      id: 'layer.all',
      title: 'Show every layer',
      group: 'Layers',
      icon: 'layers',
      keywords: ['layer', 'all', 'overview', 'reset'],
      available: hidden.some((h) => !OPT_IN_LAYER_IDS.includes(h)) || !overview,
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
