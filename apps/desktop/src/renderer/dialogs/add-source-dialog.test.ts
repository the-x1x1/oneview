import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DefinitionsReload } from '@worldview/ipc-contract';
import { DemoClient } from '../demo/demo-client.js';
import { AddSourceFlow, checkDefinitionId, checkDraftUrl } from '../panels/sources-definitions-model.js';
import {
  DefinitionsTestClient,
  draftOf,
  file,
  ipcError,
  listing,
  reloaded,
  settle,
} from '../panels/sources-test-client.js';
import { AddSourceDialog, announce } from './add-source-dialog.js';

const FOLDER = '/home/op/.config/WorldView/connectors';
const URL_OK = 'https://example.org/stations.geojson';

function renderDialog(flow: AddSourceFlow): string {
  return renderToStaticMarkup(
    createElement(AddSourceDialog, {
      client: new DefinitionsTestClient(),
      takenIds: () => new Set<string>(),
      onSaved: () => undefined,
      onOpenFolder: async () => null,
      onClose: () => undefined,
      flow,
    }),
  );
}

function savingClient() {
  const saved: Array<{ id: string; definition: unknown }> = [];
  const client = new DefinitionsTestClient()
    .on('sources.definitions.draft', () => draftOf())
    .on('sources.definitions.save', ({ id, definition }) => {
      saved.push({ id, definition });
      return {
        file: `${id}.json`,
        listing: reloaded(listing(FOLDER, [file(`${id}.json`, { id, connector: 'geojson' })]), { added: [id] }),
      };
    });
  return { client, saved };
}

test('address: checked before anything is sent — https only, no credentials in it', async () => {
  assert.equal(checkDraftUrl(''), 'Enter the address of a JSON, GeoJSON or CSV sample.');
  assert.match(checkDraftUrl('example.org/x.json')!, /start with https/);
  assert.equal(checkDraftUrl('http://example.org/x.json'), 'Only https addresses can be drafted.');
  assert.match(checkDraftUrl('https://user:pw@example.org/x.json')!, /Leave credentials out/);
  assert.equal(checkDraftUrl(`  ${URL_OK} `), null);

  const client = new DefinitionsTestClient();
  const flow = new AddSourceFlow(client);
  flow.setUrl('http://example.org/x.json');
  await flow.draft();
  assert.equal(client.calls.length, 0, 'nothing sent for an address that cannot be drafted');
  const html = renderDialog(flow);
  assert.match(html, /role="alert"[^>]*>Only https addresses can be drafted\./);
  assert.match(html, /aria-invalid="true"/);
});

test('id: the runtime rule, and ids already used by a source or a file', () => {
  const taken = new Set(['usgs-earthquakes']);
  assert.equal(checkDefinitionId('my-stations', taken), null);
  assert.match(checkDefinitionId('x', taken)!, /2–63 characters/);
  assert.match(checkDefinitionId('-lead', taken)!, /2–63 characters/);
  assert.match(checkDefinitionId('Upper', taken)!, /2–63 characters/);
  assert.match(checkDefinitionId('a'.repeat(64), taken)!, /2–63 characters/);
  assert.equal(checkDefinitionId('usgs-earthquakes', taken), 'usgs-earthquakes is already used by another source.');
});

test('flow: address → draft (sent once, trimmed) → valid → save writes the draft under the id shown', async () => {
  const { client, saved } = savingClient();
  const events: Array<{ file: string; listing: DefinitionsReload }> = [];
  const flow = new AddSourceFlow(
    client,
    () => new Set(['taken']),
    (f, l) => events.push({ file: f, listing: l }),
  );

  flow.setUrl(`  ${URL_OK}  `);
  client.hold('sources.definitions.draft');
  const drafting = flow.draft();
  assert.equal(flow.getState().step, 'url');
  assert.match(renderDialog(flow), /Drafting…/);
  void flow.draft(); // a second press while waiting sends nothing
  client.release('sources.definitions.draft');
  await drafting;
  assert.equal(client.count('sources.definitions.draft'), 1);
  assert.deepEqual(client.calls[0]!.request, { url: URL_OK });

  const s = flow.getState();
  assert.equal(s.step, 'draft');
  assert.equal(s.step === 'draft' && s.id, 'example-org-stations', 'the drafter’s id is proposed');
  let html = renderDialog(flow);
  assert.match(html, /<dd class="wv-fields__value wv-num">valid<\/dd>/);
  assert.match(html, />geojson</);
  assert.match(html, /Still to do before you enable it/);
  assert.match(html, /attribution.text and termsUrl/);
  assert.match(html, /What the drafter found/);
  assert.match(html, /Will be saved as example-org-stations.json in your folder\./);
  assert.match(html, /Definition as drafted/);
  assert.ok(flow.canSave());

  flow.setId('Upper');
  assert.equal(flow.canSave(), false);
  assert.match(renderDialog(flow), /2–63 characters: lower-case letters/, 'the runtime would refuse it');
  flow.setId('taken ');
  const renamed = flow.getState();
  assert.equal(renamed.step === 'draft' && renamed.id, 'taken ', 'stored as typed, so the caret stays put');
  assert.equal(flow.canSave(), false);
  html = renderDialog(flow);
  assert.match(html, /taken is already used by another source\./);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Save to folder/);
  await flow.save();
  assert.equal(client.count('sources.definitions.save'), 0, 'a taken id is not sent');

  flow.setId(' my-stations ');
  await flow.save();
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.id, 'my-stations');
  assert.deepEqual(saved[0]!.definition, draftOf().definition, 'the definition is the draft, unedited');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.file, 'my-stations.json');
  assert.deepEqual(events[0]!.listing.added, ['my-stations']);
  const done = flow.getState();
  assert.equal(done.step, 'saved');
  html = renderDialog(flow);
  assert.match(html, /Saved <span class="wv-mono">my-stations.json<\/span> in your folder/);
  assert.match(html, /listed under Definitions, disabled\./);
  assert.doesNotMatch(html, /It is on because/);
  assert.match(html, /Before you switch it on, edit the file to/);
  assert.match(html, /Open folder/);

  flow.startOver();
  assert.deepEqual(flow.getState(), { step: 'url', url: '', busy: false, error: null }, 'Add another starts clean');
});

test('flow: a draft that does not validate shows why and cannot be saved', async () => {
  const client = new DefinitionsTestClient().on('sources.definitions.draft', () =>
    draftOf({ validation: { ok: false, errors: ['mapping.position: required'], warnings: ['no freshness'] } }),
  );
  const flow = new AddSourceFlow(client);
  flow.setUrl(URL_OK);
  await flow.draft();
  assert.equal(flow.canSave(), false);
  const html = renderDialog(flow);
  assert.match(html, /does not validate \(1 error\)/);
  assert.match(html, /Why it cannot be saved/);
  assert.match(html, /mapping.position: required/);
  assert.match(html, /Validator notes/);
  await flow.save();
  assert.equal(client.count('sources.definitions.save'), 0);
  const s = flow.getState();
  assert.equal(s.step === 'draft' && s.error, 'This draft does not validate, so it cannot be saved.');
});

test('flow: DENIED, UNAVAILABLE and INVALID_REQUEST from the runtime are shown as sentences', async () => {
  const client = new DefinitionsTestClient().on('sources.definitions.draft', ({ url }) => {
    if (url.includes('internal'))
      throw ipcError('DENIED', 'the URL names a private-use host', 'sources.definitions.draft');
    throw ipcError('UNAVAILABLE', 'the URL answered 404', 'sources.definitions.draft');
  });
  const flow = new AddSourceFlow(client);
  flow.setUrl('https://intranet.internal/x.json');
  await flow.draft();
  let s = flow.getState();
  assert.equal(
    s.step === 'url' && s.error,
    'The URL names a private-use host. Only https addresses on public hosts can be drafted.',
  );
  assert.equal(s.step === 'url' && s.busy, false);
  flow.setUrl(URL_OK);
  await flow.draft();
  s = flow.getState();
  assert.equal(s.step === 'url' && s.error, 'The URL answered 404.');

  const saveClient = new DefinitionsTestClient()
    .on('sources.definitions.draft', () => draftOf())
    .on('sources.definitions.save', () => {
      throw ipcError('INVALID_REQUEST', 'example-org-stations.json already exists in the folder');
    });
  const saving = new AddSourceFlow(saveClient);
  saving.setUrl(URL_OK);
  await saving.draft();
  await saving.save();
  const after = saving.getState();
  assert.equal(after.step, 'draft', 'the draft stays so another id can be tried');
  assert.equal(after.step === 'draft' && after.error, 'example-org-stations.json already exists in the folder.');
  assert.equal(after.step === 'draft' && after.busy, false);
});

test('flow: demo mode answers UNAVAILABLE and nothing is drafted', async () => {
  const flow = new AddSourceFlow(new DemoClient());
  flow.setUrl(URL_OK);
  await flow.draft();
  const s = flow.getState();
  assert.equal(s.step, 'url');
  assert.equal(s.step === 'url' && s.error, 'Demo mode has no definition folder.');
});

test('flow: a draft that answers after the dialog closed or the operator started over is dropped', async () => {
  const client = new DefinitionsTestClient().on('sources.definitions.draft', () => draftOf());
  const closed = new AddSourceFlow(client);
  closed.setUrl(URL_OK);
  client.hold('sources.definitions.draft');
  const pending = closed.draft();
  closed.dispose();
  client.release('sources.definitions.draft');
  await pending;
  assert.equal(closed.getState().step, 'url', 'no draft applied to a closed dialog');

  // Start over, then a new draft: the first answer, arriving late, does not replace the second.
  let n = 0;
  const twice = new DefinitionsTestClient().on('sources.definitions.draft', () =>
    draftOf({ connector: ++n === 1 ? 'first' : 'second' }),
  );
  const again = new AddSourceFlow(twice);
  again.setUrl(URL_OK);
  await again.draft();
  twice.hold('sources.definitions.draft');
  again.startOver();
  const late = again.draft();
  again.startOver();
  twice.release('sources.definitions.draft');
  await late;
  assert.equal(again.getState().step, 'url', 'the answer to an abandoned draft is dropped');

  // A save still in flight when the dialog closes lands in the Definitions list anyway.
  const { client: saveClient } = savingClient();
  const seen: string[] = [];
  const flow = new AddSourceFlow(saveClient, undefined, (f) => seen.push(f));
  flow.setUrl(URL_OK);
  await flow.draft();
  saveClient.hold('sources.definitions.save');
  const saving = flow.save();
  const busyHtml = renderDialog(flow);
  assert.match(busyHtml, /Saving…/);
  // The waiting Save button stays focusable; Cancel stays usable (the save lands anyway).
  assert.match(busyHtml, /<button type="submit"[^>]*aria-disabled="true"/);
  assert.doesNotMatch(busyHtml, /<button type="submit"[^>]*disabled=""/);
  flow.startOver(); // ignored while saving
  assert.equal(flow.getState().step, 'draft');
  flow.dispose();
  saveClient.release('sources.definitions.save');
  await saving;
  await settle();
  assert.deepEqual(seen, ['example-org-stations.json']);
});

test('dialog: labelled controls and a polite status line for screen readers', () => {
  const flow = new AddSourceFlow(new DefinitionsTestClient());
  const html = renderDialog(flow);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /<h2 id="[^"]+-title" class="wv-dialog__title">Add source<\/h2>/);
  assert.match(html, /<label class="wv-field" for="([^"]+)-url">Sample address<input id="\1-url"/);
  assert.match(html, /type="url"/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/, 'Draft waits for an address');
});

test('address: a key in the query string is refused before sending, since the address is written to the file', () => {
  assert.match(checkDraftUrl('https://api.example.com/v1/obs?apikey=abc123')!, /Leave the apikey parameter out/);
  assert.match(checkDraftUrl('https://api.example.com/v1/obs?format=json&access_token=x')!, /access_token/);
  assert.equal(checkDraftUrl('https://api.example.com/v1/obs?format=json&station=KPHX'), null);
});

test('saved: a source an earlier setting left enabled is said to be on, not reassured as disabled', async () => {
  const client = new DefinitionsTestClient()
    .on('sources.definitions.draft', () => draftOf())
    .on('sources.definitions.save', ({ id }) => ({
      file: `${id}.json`,
      listing: reloaded(listing(FOLDER, [file(`${id}.json`, { id, enabled: true })]), { added: [id] }),
    }));
  const flow = new AddSourceFlow(client);
  flow.setUrl(URL_OK);
  await flow.draft();
  await flow.save();
  const s = flow.getState();
  assert.equal(s.step === 'saved' && s.enabled, true);
  const html = renderDialog(flow);
  assert.match(html, /listed under Definitions, switched on\./);
  assert.match(
    html,
    /role="alert"[^>]*>It is on because an earlier source with the id example-org-stations was left enabled/,
  );
  assert.equal(announce(s), 'Saved example-org-stations.json. It is on.');
});

test('dialog: one live region says what each step did', async () => {
  const flow = new AddSourceFlow(savingClient().client);
  assert.equal(announce(flow.getState()), '');
  flow.setUrl(URL_OK);
  await flow.draft();
  assert.equal(announce(flow.getState()), 'Draft ready: geojson, valid, 1 to decide.');
  const html = renderDialog(flow);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1, 'a single region, present on every step');
  assert.match(html, /tabindex="-1" data-step-focus="true"/, 'each step has somewhere to put focus');
  assert.match(html, /<form[^>]*novalidate=""/i, 'the browser bubble does not replace the app’s own message');
});

test('dialog: without a flow given it starts at the address, as the app opens it', () => {
  const html = renderToStaticMarkup(
    createElement(AddSourceDialog, {
      client: new DefinitionsTestClient(),
      takenIds: () => new Set<string>(),
      onSaved: () => undefined,
      onOpenFolder: async () => null,
      onClose: () => undefined,
    }),
  );
  assert.match(html, /Sample address/);
  assert.match(html, /<input id="[^"]+-url"[^>]*data-step-focus="true"/, 'the address takes focus after Start over');
});
