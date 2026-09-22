import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Button,
  IconButton,
  Toggle,
  Tabs,
  Panel,
  FieldList,
  Section,
  Drawer,
  Popover,
  Tooltip,
  Search,
  CommandPalette,
  VirtualList,
  StatusBadge,
  SourceBadge,
  Timeline,
  initialTimelineState,
  EmptyState,
  ErrorState,
  LoadingState,
  Dialog,
  Icon,
  ICON_NAMES,
  GLYPHS,
  badgeLabel,
  type VirtualListProps,
} from './index.js';

const NOW = Date.parse('2026-09-21T08:00:00.000Z');
const render = (el: ReturnType<typeof h>) => renderToStaticMarkup(el);
const noop = () => {};

function assertNoPlaceholders(html: string) {
  assert.ok(
    !/TODO|placeholder text|lorem ipsum|coming soon/i.test(html.replace(/placeholder="[^"]*"/g, '')),
    'no placeholder text in markup',
  );
}

test('Icon: every glyph renders as a single svg with paths; decorative by default, labelled when asked', () => {
  for (const name of ICON_NAMES) {
    const html = render(h(Icon, { name }));
    assert.ok(html.startsWith('<svg'), name);
    assert.ok(html.includes('aria-hidden="true"'), name);
    assert.equal((html.match(/<path /g) ?? []).length, GLYPHS[name].length, name);
  }
  const labelled = render(h(Icon, { name: 'search', label: 'Search' }));
  assert.ok(
    labelled.includes('role="img"') &&
      labelled.includes('aria-label="Search"') &&
      labelled.includes('<title>Search</title>'),
  );
  assert.ok(ICON_NAMES.length >= 24);
});

test('Button / IconButton: variants, pressed state, accessible names', () => {
  const html = render(h(Button, { variant: 'primary', icon: 'play', pressed: true }, 'Play'));
  assert.ok(
    html.includes('type="button"') &&
      html.includes('wv-btn--primary') &&
      html.includes('aria-pressed="true"') &&
      html.includes('Play'),
  );
  const icon = render(h(IconButton, { icon: 'close', label: 'Close' }));
  assert.ok(icon.includes('aria-label="Close"') && icon.includes('title="Close"') && !icon.includes('Close</'));
  assertNoPlaceholders(html);
});

test('Toggle: role=switch with aria-checked and label association', () => {
  const html = render(
    h(Toggle, { checked: true, onChange: noop, label: 'Automatic updates', description: 'Downloads are verified' }),
  );
  assert.ok(
    html.includes('role="switch"') &&
      html.includes('aria-checked="true"') &&
      html.includes('Automatic updates') &&
      html.includes('Downloads are verified'),
  );
  assert.match(html, /aria-labelledby="[^"]+"/);
});

test('Tabs: tablist with roving tabindex and controlled panel', () => {
  const items = [
    { id: 'selection', label: 'Selection' },
    { id: 'sources', label: 'Sources', badge: 3 },
    { id: 'timeline', label: 'Timeline', disabled: true },
  ];
  const html = render(h(Tabs, { items, activeId: 'sources', onChange: noop, label: 'Context' }, h('p', null, 'Body')));
  assert.ok(html.includes('role="tablist"') && html.includes('aria-label="Context"'));
  assert.ok(html.includes('aria-selected="true"') && html.includes('role="tabpanel"') && html.includes('Body'));
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 2);
  assert.ok(html.includes('>3</span>'));
});

test('Panel, FieldList, Section: undefined values are omitted, region landmark', () => {
  const html = render(
    h(
      Panel,
      { title: 'Sources', subtitle: '8 sources', region: true },
      h(
        Section,
        { title: 'Identity' },
        h(FieldList, {
          rows: [
            { label: 'Callsign', value: 'UAL123' },
            { label: 'Registration', value: undefined },
          ],
        }),
      ),
    ),
  );
  assert.ok(html.includes('role="region"') && html.includes('aria-label="Sources"') && html.includes('8 sources'));
  assert.ok(html.includes('Callsign') && html.includes('UAL123') && !html.includes('Registration'));
  const empty = render(h(FieldList, { rows: [{ label: 'x', value: undefined }] }));
  assert.equal(empty, '');
});

test('Drawer / Dialog: closed renders nothing; open renders dialog semantics', () => {
  assert.equal(render(h(Drawer, { open: false, title: 'Settings', onClose: noop })), '');
  assert.equal(render(h(Dialog, { open: false, title: 'Settings', onClose: noop })), '');
  const drawer = render(h(Drawer, { open: true, title: 'Settings', onClose: noop, side: 'left' }, 'content'));
  assert.ok(
    drawer.includes('<aside') &&
      drawer.includes('wv-drawer--left') &&
      drawer.includes('Settings') &&
      drawer.includes('content'),
  );
  const dialog = render(
    h(
      Dialog,
      {
        open: true,
        title: 'Diagnostics',
        description: 'Runtime state',
        onClose: noop,
        footer: h(Button, null, 'Close'),
      },
      'body',
    ),
  );
  assert.ok(
    dialog.includes('role="dialog"') &&
      dialog.includes('aria-modal="true"') &&
      dialog.includes('Diagnostics') &&
      dialog.includes('Runtime state') &&
      dialog.includes('body'),
  );
  const locked = render(h(Dialog, { open: true, title: 'Welcome', onClose: noop, dismissible: false }));
  assert.ok(!locked.includes('aria-label="Close"'));
});

test('Popover / Tooltip', () => {
  const pop = render(
    h(Popover, {
      label: 'Speed',
      open: true,
      renderTrigger: (p) => h('button', { ...p, type: 'button' }, 'Open'),
      children: 'inside',
    }),
  );
  assert.ok(pop.includes('aria-expanded="true"') && pop.includes('role="dialog"') && pop.includes('inside'));
  const closed = render(
    h(Popover, {
      label: 'Speed',
      renderTrigger: (p) => h('button', { ...p, type: 'button' }, 'Open'),
      children: 'inside',
    }),
  );
  assert.ok(!closed.includes('inside'));
  const tip = render(h(Tooltip, { text: 'Jump to live', children: h('span', null, 'x') }));
  assert.ok(tip.includes('role="tooltip"') && tip.includes('Jump to live') && /aria-describedby="[^"]+"/.test(tip));
});

test('Search: combobox semantics, results list, empty text', () => {
  const results = [{ id: 'place:hnl', title: 'Honolulu', subtitle: 'Place', hint: 'place' }];
  const html = render(
    h(Search, { label: 'Search', value: 'hon', onChange: noop, results, onPick: noop, inline: true }),
  );
  assert.ok(
    html.includes('role="combobox"') &&
      html.includes('aria-autocomplete="list"') &&
      html.includes('role="listbox"') &&
      html.includes('Honolulu') &&
      html.includes('Place'),
  );
  const empty = render(
    h(Search, {
      label: 'Search',
      value: 'zzz',
      onChange: noop,
      results: [],
      onPick: noop,
      inline: true,
      emptyText: 'Nothing found',
    }),
  );
  assert.ok(empty.includes('Nothing found'));
});

test('CommandPalette: closed renders nothing; open lists available commands with groups and shortcuts', () => {
  const commands = [
    { id: 'a', title: 'Jump to live', group: 'Timeline', shortcut: 'L', run: noop },
    { id: 'b', title: 'Hidden command', available: false, run: noop },
  ];
  assert.equal(render(h(CommandPalette, { open: false, onClose: noop, commands })), '');
  const html = render(h(CommandPalette, { open: true, onClose: noop, commands }));
  assert.ok(
    html.includes('aria-label="Command palette"') &&
      html.includes('Jump to live') &&
      html.includes('Timeline') &&
      !html.includes('Hidden command'),
  );
  assertNoPlaceholders(html);
});

test('VirtualList: renders only the windowed rows with listbox semantics; empty state', () => {
  interface Row {
    id: string;
    label: string;
  }
  const RowList = VirtualList as (props: VirtualListProps<Row>) => ReactNode;
  const items: Row[] = Array.from({ length: 500 }, (_, i) => ({ id: `row-${i}`, label: `Row ${i}` }));
  const html = render(
    h(RowList, {
      items,
      itemHeight: 32,
      height: 320,
      label: 'Feed',
      getKey: (it) => it.id,
      renderItem: (it) => h('span', null, it.label),
      selectedKey: 'row-2',
    }),
  );
  assert.ok(html.includes('role="listbox"') && html.includes('aria-label="Feed"'));
  const rows = (html.match(/role="option"/g) ?? []).length;
  assert.ok(rows >= 11 && rows <= 16, `rows=${rows}`);
  assert.ok(html.includes('Row 0') && !html.includes('Row 100'));
  assert.ok(html.includes('height:16000px'));
  assert.ok(html.includes('aria-selected="true"'));
  const empty = render(
    h(RowList, {
      items: [],
      itemHeight: 32,
      height: 100,
      label: 'Feed',
      getKey: () => '',
      renderItem: () => null,
      emptyState: h(EmptyState, { title: 'No events yet' }),
    }),
  );
  assert.ok(empty.includes('No events yet'));
});

test('StatusBadge / SourceBadge: labels for every kind; text carries meaning', () => {
  assert.equal(badgeLabel({ kind: 'freshness', value: 'LIVE' }).text, 'LIVE');
  assert.equal(badgeLabel({ kind: 'connection', value: 'OFFLINE' }).text, 'OFFLINE');
  assert.equal(badgeLabel({ kind: 'connection', value: 'CONNECTED' }).text, 'LIVE');
  assert.equal(badgeLabel({ kind: 'provider', value: 'AUTH_REQUIRED' }).text, 'Credentials required');
  assert.equal(badgeLabel({ kind: 'severity', value: 'EXTREME' }).text, 'Extreme');
  assert.equal(badgeLabel({ kind: 'confidence', value: 'MEDIUM' }).text, 'Medium confidence');
  assert.equal(badgeLabel({ kind: 'recorded' }).text, 'RECORDED DATA');
  assert.equal(badgeLabel({ kind: 'cached' }).text, 'cached');
  const html = render(h(StatusBadge, { kind: 'freshness', value: 'STALE', size: 'sm' }));
  assert.ok(html.includes('STALE') && html.includes('wv-badge--fresh-stale'));
  const src = render(
    h(SourceBadge, { name: 'USGS Earthquakes', status: 'LIVE', providerId: 'usgs-earthquakes', onClick: noop }),
  );
  assert.ok(
    src.includes('<button') &&
      src.includes('USGS Earthquakes') &&
      src.includes('Live') &&
      src.includes('data-provider="usgs-earthquakes"'),
  );
});

test('Timeline: transport, speeds, slider semantics, availability honesty', () => {
  const state = initialTimelineState(NOW);
  const html = render(h(Timeline, { state, dispatch: noop }));
  assert.ok(html.includes('aria-label="Pause"'), 'LIVE shows pause');
  assert.ok(html.includes('role="radiogroup"') && html.includes('0.25×') && html.includes('60×'));
  assert.ok(
    html.includes('role="slider"') &&
      html.includes('aria-disabled="true"') &&
      html.includes('No history available yet'),
  );
  assert.ok(html.includes('>LIVE<'));
  const hist = {
    ...state,
    mode: 'HISTORICAL' as const,
    cursorMs: NOW - 3600_000,
    availability: [{ objectType: 'earthquake', ranges: [{ startMs: NOW - 86_400_000, endMs: NOW }] }],
  };
  const h2 = render(h(Timeline, { state: hist, dispatch: noop, typeLabels: { earthquake: 'Earthquakes' } }));
  assert.ok(
    h2.includes('aria-label="Play"') &&
      h2.includes('Earthquakes') &&
      h2.includes('aria-disabled="false"') &&
      h2.includes('07:00:00 UTC') &&
      h2.includes('HISTORICAL'),
  );
  assert.ok(h2.includes('wv-timeline__mark'));
});

test('Empty / Error / Loading states', () => {
  const e = render(
    h(EmptyState, {
      title: 'No selection',
      description: 'Pick something on the map',
      action: { label: 'Search', onClick: noop },
    }),
  );
  assert.ok(
    e.includes('role="status"') &&
      e.includes('No selection') &&
      e.includes('Pick something on the map') &&
      e.includes('Search'),
  );
  const err = render(h(ErrorState, { title: 'Source unavailable', message: 'HTTP 503', retry: { onClick: noop } }));
  assert.ok(err.includes('role="alert"') && err.includes('HTTP 503') && err.includes('Retry'));
  const l = render(h(LoadingState, { label: 'Loading sources' }));
  assert.ok(l.includes('aria-busy="true"') && l.includes('Loading sources'));
});
