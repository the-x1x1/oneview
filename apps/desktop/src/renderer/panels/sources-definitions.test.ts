import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DemoClient } from '../demo/demo-client.js';
import { DefinitionsSection } from './sources-definitions.js';
import {
  DefinitionsController,
  definitionRows,
  definitionsSummary,
  describeDefinitionError,
  reloadSummary,
} from './sources-definitions-model.js';
import { DefinitionsTestClient, file, ipcError, listing, reloaded, settle } from './sources-test-client.js';

const FOLDER = 'C:\\Users\\op\\AppData\\Roaming\\WorldView\\connectors';

const sample = () =>
  listing(FOLDER, [
    file('bundled/nws-alerts.json', { id: 'nws-alerts', connector: 'geojson', enabled: true }),
    file('stations.json', {
      id: 'my-stations',
      connector: 'rest-json',
      enabled: false,
      warnings: ['no freshness set'],
    }),
    file('broken.json', { problems: ['connector: must be one of rest-json, geojson, csv, websocket-json'] }),
  ]);

const render = (controller: DefinitionsController, entries: Array<{ providerId: string; enabled: boolean }> = []) =>
  renderToStaticMarkup(
    createElement(DefinitionsSection, {
      controller,
      state: controller.getState(),
      entries,
      onAddSource: () => undefined,
    }),
  );

test('definitions: demo mode reports no folder, and the section renders nothing at all', async () => {
  const controller = new DefinitionsController(new DemoClient());
  assert.equal(render(controller), '', 'nothing while the first listing is on its way');
  await controller.load();
  assert.equal(controller.getState().status, 'ready');
  assert.equal(controller.getState().listing?.folder, null);
  assert.equal(render(controller), '');
});

test('definitions: a runtime without a folder (folder: null) renders nothing even with files listed', async () => {
  const client = new DefinitionsTestClient().on('sources.definitions.list', () =>
    listing(null, [file('bundled/x.json', { id: 'x' })]),
  );
  const controller = new DefinitionsController(client);
  await controller.load();
  assert.equal(render(controller), '');
});

test('definitions: folder, controls, every file with its state, connector and rejection reasons', async () => {
  const client = new DefinitionsTestClient().on('sources.definitions.list', sample);
  const controller = new DefinitionsController(client);
  await controller.load();
  const html = render(controller);
  assert.match(html, /Definitions/);
  assert.ok(html.includes('WorldView\\connectors'), 'the folder path is shown');
  assert.match(html, /3 files · 2 loaded · 1 rejected/);
  for (const label of ['Open folder', 'Reload', 'Add source']) assert.ok(html.includes(label), label);
  // The operator's files before the shipped ones.
  assert.ok(html.indexOf('broken.json') < html.indexOf('nws-alerts.json (shipped)'));
  assert.ok(html.indexOf('stations.json') < html.indexOf('nws-alerts.json (shipped)'));
  assert.match(html, /data-file="broken.json" data-state="rejected"/);
  assert.match(html, /aria-label="Why broken.json was rejected"/);
  assert.match(html, /connector: must be one of rest-json/);
  assert.match(html, /data-file="stations.json" data-state="disabled"/);
  assert.match(html, /my-stations · disabled/);
  assert.match(html, />rest-json</);
  assert.match(html, /1 note from the validator/);
  assert.match(html, /aria-label="Enable stations.json"/);
  assert.match(html, /aria-label="Disable nws-alerts.json \(shipped\)"/);
  // A rejected file has no switch: nothing loaded, so there is no source to enable.
  assert.equal((html.match(/role="switch"/g) ?? []).length, 2);
  assert.match(html, /role="status" aria-live="polite"/);
});

test('definitions: an empty folder says how to add one', async () => {
  const client = new DefinitionsTestClient().on('sources.definitions.list', () => listing(FOLDER, []));
  const controller = new DefinitionsController(client);
  await controller.load();
  const html = render(controller);
  assert.match(html, /no definition files/);
  assert.match(html, /No definition files yet/);
});

test('definitions: a listing that fails is shown with a way to try again, not hidden', async () => {
  const client = new DefinitionsTestClient().on('sources.definitions.list', () => {
    throw ipcError('INTERNAL', 'the runtime is not ready');
  });
  const controller = new DefinitionsController(client);
  await controller.load();
  assert.equal(controller.getState().status, 'failed');
  const html = render(controller);
  assert.match(html, /role="alert"/);
  assert.match(html, /could not be listed: the runtime is not ready \(INTERNAL\)/);
  assert.match(html, /Try again/);
});

test('definition rows: enabled comes from the live source list when it has the source', () => {
  const rows = definitionRows(sample(), [
    { providerId: 'my-stations', enabled: true },
    { providerId: 'nws-alerts', enabled: false },
  ]);
  const byFile = Object.fromEntries(rows.map((r) => [r.file, r]));
  assert.equal(byFile['stations.json']!.state, 'enabled');
  assert.equal(byFile['bundled/nws-alerts.json']!.state, 'disabled');
  assert.equal(byFile['broken.json']!.state, 'rejected');
  assert.equal(byFile['broken.json']!.switchable, false);
  // A file with an id whose load still failed (an id already taken, say) has no switch either.
  const taken = definitionRows(listing(FOLDER, [file('dup.json', { id: 'usgs', problems: ['id usgs is taken'] })]));
  assert.equal(taken[0]!.state, 'rejected');
  assert.equal(taken[0]!.switchable, false);
  assert.equal(definitionsSummary([]), 'no definition files');
});

test('reload: runs once at a time and says what it started, restarted and stopped', async () => {
  const after = reloaded(sample(), { added: ['my-stations'], restarted: ['nws-alerts'], removed: ['old-feed'] });
  const client = new DefinitionsTestClient()
    .on('sources.definitions.list', sample)
    .on('sources.definitions.reload', () => after);
  const controller = new DefinitionsController(client);
  await controller.load();
  client.hold('sources.definitions.reload');
  const first = controller.reload();
  assert.equal(controller.getState().busy, 'reload');
  assert.match(render(controller), /Reloading…/);
  void controller.reload(); // ignored while the first runs
  client.release('sources.definitions.reload');
  await first;
  await settle();
  assert.equal(client.count('sources.definitions.reload'), 1);
  assert.equal(controller.getState().busy, null);
  assert.equal(
    controller.getState().notice,
    'Reloaded: started my-stations; restarted nws-alerts; stopped old-feed. 1 file was rejected.',
  );
  assert.equal(reloadSummary(reloaded(listing(FOLDER, []))), 'Reloaded: no source changed.');
});

test('reload: a failure is reported and the last listing stays', async () => {
  const client = new DefinitionsTestClient()
    .on('sources.definitions.list', sample)
    .on('sources.definitions.reload', () => {
      throw ipcError('UNAVAILABLE', 'this runtime has no definition folder');
    });
  const controller = new DefinitionsController(client);
  await controller.load();
  await controller.reload();
  const s = controller.getState();
  assert.equal(s.error, 'this runtime has no definition folder');
  assert.equal(s.listing?.files.length, 3);
  assert.match(render(controller), /role="alert"[^>]*>this runtime has no definition folder/);
});

test('enable: the switch waits for the runtime and the answer replaces the listing', async () => {
  let current = sample();
  const client = new DefinitionsTestClient()
    .on('sources.definitions.list', () => current)
    .on('sources.definitions.setEnabled', ({ file: f, enabled }) => {
      current = { ...current, files: current.files.map((x) => (x.file === f ? { ...x, enabled } : x)) };
      return current;
    });
  const controller = new DefinitionsController(client);
  await controller.load();
  client.hold('sources.definitions.setEnabled');
  const done = controller.setEnabled('stations.json', true);
  assert.deepEqual(controller.getState().pending, ['stations.json']);
  assert.match(render(controller), /aria-label="Enable stations.json"[^>]*disabled=""/);
  void controller.setEnabled('stations.json', true); // a second click while waiting sends nothing
  client.release('sources.definitions.setEnabled');
  await done;
  await settle();
  assert.equal(client.count('sources.definitions.setEnabled'), 1);
  assert.deepEqual(client.calls.find((c) => c.channel === 'sources.definitions.setEnabled')?.request, {
    file: 'stations.json',
    enabled: true,
  });
  assert.deepEqual(controller.getState().pending, []);
  assert.equal(controller.getState().notice, 'stations.json enabled.');
  assert.match(render(controller), /data-file="stations.json" data-state="enabled"/);
});

test('enable: NOT_FOUND and INVALID_REQUEST come back as messages fit to show', async () => {
  const client = new DefinitionsTestClient()
    .on('sources.definitions.list', sample)
    .on('sources.definitions.setEnabled', ({ file: f }) => {
      if (f === 'gone.json') throw ipcError('NOT_FOUND', 'no definition file gone.json');
      throw ipcError('INVALID_REQUEST', `${f} did not load, so it has no source to enable`);
    });
  const controller = new DefinitionsController(client);
  await controller.load();
  await controller.setEnabled('gone.json', true);
  assert.equal(
    controller.getState().error,
    'no definition file gone.json. The folder changed since it was listed; reload it.',
  );
  await controller.setEnabled('broken.json', true);
  assert.equal(controller.getState().error, 'broken.json did not load, so it has no source to enable');
  assert.deepEqual(controller.getState().pending, []);
});

test('ordering: an older answer never replaces a newer one, and overlapping changes are listed again', async () => {
  const older = listing(FOLDER, [file('a.json', { id: 'a', enabled: false })]);
  const newer = listing(FOLDER, [file('a.json', { id: 'a', enabled: true })]);
  const final = listing(FOLDER, [file('a.json', { id: 'a', enabled: true }), file('b.json', { id: 'b' })]);
  let listCalls = 0;
  const client = new DefinitionsTestClient()
    .on('sources.definitions.list', () => (listCalls++ === 0 ? older : final))
    .on('sources.definitions.reload', () => reloaded(older))
    .on('sources.definitions.setEnabled', () => newer);
  const controller = new DefinitionsController(client);
  await controller.load();
  client.hold('sources.definitions.reload');
  const reload = controller.reload(); // sent first, answers last
  await controller.setEnabled('a.json', true);
  assert.equal(controller.getState().listing, newer);
  client.hold('sources.definitions.list');
  client.release('sources.definitions.reload');
  await reload;
  await settle();
  assert.equal(controller.getState().listing, newer, 'the late reload answer was not applied over the switch');
  assert.equal(client.count('sources.definitions.list'), 2, 'listed once more after the overlap');
  client.release('sources.definitions.list');
  await settle();
  assert.equal(controller.getState().listing, final);
});

test('open folder: reports a folder the OS would not open', async () => {
  const client = new DefinitionsTestClient()
    .on('sources.definitions.list', sample)
    .on('sources.definitions.openFolder', () => ({ opened: false, folder: FOLDER }));
  const controller = new DefinitionsController(client);
  await controller.load();
  await controller.openFolder();
  assert.equal(controller.getState().error, `The folder could not be opened: ${FOLDER}`);
  client.on('sources.definitions.openFolder', () => ({ opened: true, folder: FOLDER }));
  await controller.openFolder();
  assert.equal(controller.getState().error, null);
  assert.equal(controller.getState().notice, `Opened ${FOLDER}.`);
});

test('errors: every code the amendment names reads as a sentence, never a stack or an object', () => {
  assert.equal(
    describeDefinitionError(ipcError('DENIED', 'the URL names a private address')),
    'the URL names a private address. Only https addresses on public hosts can be drafted.',
  );
  assert.equal(describeDefinitionError(ipcError('UNAVAILABLE', 'the URL answered 404')), 'the URL answered 404');
  assert.equal(describeDefinitionError(ipcError('INVALID_REQUEST', 'id x is taken')), 'id x is taken');
  assert.equal(describeDefinitionError(ipcError('CANCELLED', 'stopped')), 'stopped (CANCELLED)');
  assert.equal(describeDefinitionError(new Error('socket hang up')), 'socket hang up');
  assert.equal(describeDefinitionError({ weird: true }), 'The request failed.');
});
