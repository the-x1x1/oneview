import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SourceHealthEntry } from '@worldview/source-health';
import { DemoClient } from '../demo/demo-client.js';
import { installClock } from '../hooks/use-now.js';
import { loadInitialState } from '../store/bootstrap-state.js';
import type { RootState } from '../store/types.js';
import { StoreProvider } from '../store/store.js';
import { ConnectorBadge, SourceLocalityLine, connectorOf, definitionFileLabel } from './sources-connector-badge.js';
import { SourcesPanel } from './sources-panel.js';

const T0 = Date.parse('2026-09-24T08:00:00.000Z');
installClock(() => T0);

const withMeta = (e: SourceHealthEntry, meta: Partial<SourceHealthEntry['meta']>): SourceHealthEntry => ({
  ...e,
  meta: { ...e.meta, ...meta },
});

async function panelHtml(edit: (s: RootState) => RootState): Promise<{ html: string; state: RootState }> {
  const client = new DemoClient({ now: () => T0 });
  const state = edit(await loadInitialState(client, () => T0));
  const html = renderToStaticMarkup(
    createElement(StoreProvider, { client, initial: state, now: () => T0 }, createElement(SourcesPanel)),
  );
  return { html, state };
}

test('connector badge: only a definition has one; its id is announced as a connector', () => {
  assert.equal(connectorOf({ meta: { connector: 'rest-json' } as SourceHealthEntry['meta'] }), 'rest-json');
  assert.equal(connectorOf({ meta: { connector: '  ' } as SourceHealthEntry['meta'] }), undefined);
  assert.equal(connectorOf({ meta: {} as SourceHealthEntry['meta'] }), undefined);
  const html = renderToStaticMarkup(createElement(ConnectorBadge, { connector: 'ogc-features' }));
  assert.match(html, /class="wv-badge wv-badge--sm wv-connector-badge"/);
  assert.match(
    html,
    /<span class="wv-visually-hidden">connector <\/span><span class="wv-badge__text"[^>]*>ogc-features</,
  );
  assert.match(html, /title="Connector definition, run by ogc-features"/);
  // The badge is a flex box, so the ellipsis must sit on the text span, not the badge.
  assert.match(
    html,
    /<span class="wv-badge__text" style="[^"]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap">/,
    'a long id is cut, never widening the cell',
  );
  const plain = renderToStaticMarkup(
    createElement(SourceLocalityLine, { entry: { locality: 'remote', meta: {} as SourceHealthEntry['meta'] } }),
  );
  assert.equal(plain, '<span class="wv-sources__locality">remote</span>', 'a bespoke provider reads as before');
  assert.equal(definitionFileLabel('bundled/nws.json'), 'nws.json (shipped)');
  assert.equal(definitionFileLabel('mine.json'), 'mine.json');
});

test('sources panel: the badge sits in the name cell, so the table keeps its four fixed columns', async () => {
  const { html, state } = await panelHtml((s) => {
    const [first, ...rest] = s.sources.entries;
    return {
      ...s,
      sources: {
        ...s.sources,
        entries: [withMeta(first!, { connector: 'geojson', definitionFile: 'bundled/quakes.json' }), ...rest],
      },
    };
  });
  assert.ok(state.sources.entries.length > 1);
  assert.equal((html.match(/<th /g) ?? []).length, 4, 'no column was added');
  assert.equal((html.match(/wv-connector-badge/g) ?? []).length, 1, 'only the definition carries a badge');
  const row = html.slice(html.indexOf(state.sources.entries[0]!.name));
  assert.ok(row.indexOf('wv-connector-badge') < row.indexOf('wv-sources__state'), 'badge is inside the name cell');
});

test('sources panel: an open definition row names its connector and file in the detail', async () => {
  const { html } = await panelHtml((s) => {
    const [first, ...rest] = s.sources.entries;
    return {
      ...s,
      ui: { ...s.ui, sourceDetailId: first!.providerId },
      sources: {
        ...s.sources,
        entries: [withMeta(first!, { connector: 'rest-json', definitionFile: 'my-stations.json' }), ...rest],
      },
    };
  });
  assert.match(html, /<dt class="wv-fields__label">Connector<\/dt><dd class="wv-fields__value wv-num">rest-json<\/dd>/);
  assert.match(
    html,
    /<dt class="wv-fields__label">Definition file<\/dt><dd class="wv-fields__value wv-mono">my-stations.json<\/dd>/,
  );
});

// The Definitions section is not in this static render at all (its listing is read in an
// effect); demo mode's `folder: null` is tested against the controller in
// sources-definitions.test.ts.
test('sources panel: bespoke sources show no connector row', async () => {
  const { html, state } = await panelHtml((s) => ({
    ...s,
    ui: { ...s.ui, sourceDetailId: s.sources.entries[0]!.providerId },
  }));
  assert.ok(state.sources.entries.every((e) => e.meta.connector === undefined));
  assert.doesNotMatch(html, />Connector</);
  assert.doesNotMatch(html, />Definition file</);
});
