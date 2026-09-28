import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SourceHealthEntry } from '@worldview/source-health';
import { GroupRow } from './layer-panel.js';
import { CAMERA_PREVIEWS_LAYER_ID, LAYER_GROUPS, MILITARY_ONLY_LAYER_ID, type LayerCount } from '../layer-tree.js';

const aviation = LAYER_GROUPS.find((g) => g.id === 'aviation')!;
const infrastructure = LAYER_GROUPS.find((g) => g.id === 'infrastructure')!;

/** An invented source that needs a key it has not been given. */
const needsKey = {
  providerId: 'opensky-network',
  name: 'OpenSky Network',
  categories: ['aviation'],
  enabled: false,
  health: { status: 'DISABLED', credentialState: 'missing' },
  meta: { credentialsRequired: ['opensky.client'] },
} as unknown as SourceHealthEntry;

function render(
  group: typeof aviation,
  opts: { expanded: boolean; hidden?: string[]; counts?: Map<string, LayerCount>; entries?: SourceHealthEntry[] },
) {
  const opened: string[] = [];
  const html = renderToStaticMarkup(
    createElement(GroupRow, {
      group,
      on: !(opts.hidden ?? []).includes(group.id),
      hidden: opts.hidden ?? [MILITARY_ONLY_LAYER_ID, CAMERA_PREVIEWS_LAYER_ID],
      counts: opts.counts ?? new Map(),
      collapsed: false,
      idle: false,
      expanded: opts.expanded,
      onExpand: () => undefined,
      entries: opts.entries ?? [],
      onSwitch: () => undefined,
      onOpenSource: (id) => opened.push(id),
    }),
  );
  return { html, opened };
}

test('layer panel: a closed group is one switch with its count and an opener', () => {
  const counts = new Map<string, LayerCount>([['aviation', { total: 4567, inView: 120 }]]);
  const { html } = render(aviation, { expanded: false, counts });
  assert.equal((html.match(/role="switch"/g) ?? []).length, 1);
  assert.ok(html.includes('aria-expanded="false"') && html.includes('Open Aviation layers'));
  assert.ok(html.includes('120') && html.includes('/4.6k'), 'in view / on hand, compact');
  assert.ok(html.includes('120 in view of 4,567 on hand'), 'in full in the tooltip');
  assert.ok(!html.includes('Military only'), 'rows only when opened');
});

test('layer panel: an opened group has a switch per type and the children under them, opt-ins off', () => {
  const { html } = render(aviation, { expanded: true, entries: [needsKey] });
  assert.ok(html.includes('>Aircraft<') && html.includes('>Airports<'));
  const military = html.match(
    /<button[^>]*role="switch"[^>]*aria-checked="(true|false)"[^>]*title="Military only[^"]*"/,
  );
  assert.equal(military?.[1], 'false', 'military only is off until switched on');
  assert.ok(html.includes('wv-layers__stem'), 'the child hangs from its layer');
  assert.ok(html.includes('OpenSky Network') && html.includes('needs key'), 'a keyless source is shown, not hidden');
  assert.ok(html.includes('Open its settings in Sources'));
  const cams = render(infrastructure, { expanded: true }).html;
  assert.ok(cams.includes('>Public cameras<') && cams.includes('>Live previews<'));
});

test('layer panel: rows of a category that is off read as inert but keep their state', () => {
  const { html } = render(aviation, { expanded: true, hidden: ['aviation'] });
  assert.ok(html.includes('wv-layers__row--inert'));
  assert.ok(html.includes('(its category is off)'));
  const aircraft = html.match(/<button[^>]*role="switch"[^>]*aria-checked="(true|false)"[^>]*title="Aircraft:/);
  assert.equal(aircraft?.[1], 'true', 'the type switch itself is still on');
});
