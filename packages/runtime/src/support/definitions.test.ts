import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { silentLogger } from '@worldview/core';
import { systemClock } from '@worldview/world-model';
import type { WorldProvider } from '@worldview/provider-sdk';
import { ConnectorDefinitions, type DefinitionsHost } from './definitions.js';

const EXAMPLE = path.resolve('connectors/examples/citibike-stations-rest.json');

class FakeHost implements DefinitionsHost {
  readonly registered = new Map<string, { enabled: boolean; connector?: string; definitionFile?: string }>();
  readonly log: string[] = [];
  register(provider: WorldProvider, opts: { enabled?: boolean; connector?: string; definitionFile?: string }): void {
    const id = provider.manifest.id;
    this.log.push(`register ${id}`);
    this.registered.set(id, {
      enabled: opts.enabled ?? false,
      ...(opts.connector ? { connector: opts.connector } : {}),
      ...(opts.definitionFile ? { definitionFile: opts.definitionFile } : {}),
    });
  }
  async unregister(id: string): Promise<boolean> {
    this.log.push(`unregister ${id}`);
    return this.registered.delete(id);
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.log.push(`setEnabled ${id} ${enabled}`);
    const r = this.registered.get(id);
    if (r) r.enabled = enabled;
  }
  list() {
    return [...this.registered].map(([id, r]) => ({ manifest: { id }, enabled: r.enabled }));
  }
}

function setup(fetchImpl?: typeof fetch) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wv-defs-'));
  const host = new FakeHost();
  const persisted: Record<string, boolean> = {};
  const removed: string[] = [];
  let changed = 0;
  const defs = new ConnectorDefinitions({
    host,
    userDir: dir,
    reservedIds: () => ['usgs-earthquakes'],
    enabledSetting: (id) => persisted[id],
    persistEnabled: async (id, enabled) => {
      persisted[id] = enabled;
    },
    removed: (id) => removed.push(id),
    changed: () => changed++,
    logger: silentLogger,
    clock: systemClock,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const register = () => {
    for (const d of defs.load()) {
      host.register({ manifest: { id: d.id, enabledByDefault: false } } as unknown as WorldProvider, {
        enabled: persisted[d.id] ?? false,
        ...defs.metaFor(d.id),
      });
    }
  };
  return {
    dir,
    host,
    defs,
    persisted,
    removed,
    changes: () => changed,
    register,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeDef(dir: string, file: string, patch: Record<string, unknown> = {}): void {
  const doc = { ...JSON.parse(readFileSync(EXAMPLE, 'utf8')), review: 'user-configured', ...patch };
  writeFileSync(path.join(dir, file), JSON.stringify(doc, null, 2));
}

test('definitions: listing carries accepted and refused files, meta says where a source came from', () => {
  const t = setup();
  try {
    writeDef(t.dir, 'bikes.json');
    writeFileSync(path.join(t.dir, 'broken.json'), '{ not json');
    writeDef(t.dir, 'taken.json', { id: 'usgs-earthquakes' });
    t.register();
    const listing = t.defs.listing();
    assert.equal(listing.folder, t.dir);
    const byFile = new Map(listing.files.map((f) => [f.file, f]));
    assert.equal(byFile.get('bikes.json')!.id, 'citibike-nyc-stations');
    assert.equal(byFile.get('bikes.json')!.connector, 'rest-json');
    assert.equal(byFile.get('bikes.json')!.enabled, false);
    assert.equal(byFile.get('bikes.json')!.bundled, false);
    assert.deepEqual(byFile.get('bikes.json')!.problems, []);
    assert.match(byFile.get('broken.json')!.problems[0]!, /not valid JSON/);
    assert.match(byFile.get('taken.json')!.problems[0]!, /already used/);
    assert.deepEqual(t.defs.metaFor('citibike-nyc-stations'), {
      connector: 'rest-json',
      definitionFile: 'bikes.json',
    });
    assert.deepEqual(t.defs.metaFor('usgs-earthquakes'), {});
  } finally {
    t.cleanup();
  }
});

test('definitions: reload stops removed files, starts new ones, restarts changed ones and leaves the rest alone', async () => {
  const t = setup();
  try {
    writeDef(t.dir, 'bikes.json');
    writeDef(t.dir, 'other.json', { id: 'bikes-two', name: 'Second' });
    t.register();
    t.host.log.length = 0;

    const quiet = await t.defs.reload();
    assert.deepEqual([quiet.added, quiet.removed, quiet.restarted], [[], [], []]);
    assert.deepEqual(t.host.log, [], 'an unchanged file is not touched');
    assert.equal(t.changes(), 0);

    writeDef(t.dir, 'other.json', { id: 'bikes-two', name: 'Second, renamed' });
    unlinkSync(path.join(t.dir, 'bikes.json'));
    writeDef(t.dir, 'third.json', { id: 'bikes-three' });
    t.persisted['bikes-three'] = true;
    const r = await t.defs.reload();
    assert.deepEqual(r.removed, ['citibike-nyc-stations']);
    assert.deepEqual(r.restarted, ['bikes-two']);
    assert.deepEqual(r.added, ['bikes-three']);
    assert.deepEqual(t.removed.sort(), ['bikes-two', 'citibike-nyc-stations']);
    assert.equal(t.host.registered.get('bikes-three')!.enabled, true, "the operator's setting applies");
    assert.equal(t.host.registered.get('bikes-two')!.definitionFile, 'other.json');
    assert.equal(t.host.registered.has('citibike-nyc-stations'), false);
    assert.equal(t.changes(), 1);
    assert.deepEqual(
      r.files.map((f) => f.file),
      ['other.json', 'third.json'],
    );
  } finally {
    t.cleanup();
  }
});

test('definitions: setEnabled maps the file to its source and persists; refused files cannot be enabled', async () => {
  const t = setup();
  try {
    writeDef(t.dir, 'bikes.json');
    writeFileSync(path.join(t.dir, 'broken.json'), '{}');
    t.register();
    const after = await t.defs.setEnabled('bikes.json', true);
    assert.equal(after.files.find((f) => f.file === 'bikes.json')!.enabled, true);
    assert.equal(t.persisted['citibike-nyc-stations'], true);
    await t.defs.setEnabled('bikes.json', false);
    assert.deepEqual(t.removed, ['citibike-nyc-stations'], 'disabled → its objects leave the world');
    await assert.rejects(t.defs.setEnabled('broken.json', true), /did not load/);
    await assert.rejects(t.defs.setEnabled('nope.json', true), /no definition file/);
  } finally {
    t.cleanup();
  }
});

test('definitions: draft fetches one sample under the URL policy and returns the validator verdict', async () => {
  const seen: string[] = [];
  const body = JSON.stringify({
    data: {
      stations: [
        { station_id: 'a', name: 'A', lat: 40.7, lon: -74, last_updated: 1_790_000_000 },
        { station_id: 'b', name: 'B', lat: 40.8, lon: -73.9, last_updated: 1_790_000_000 },
      ],
    },
  });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(url)} redirect=${String(init?.redirect)}`);
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const t = setup(fetchImpl);
  try {
    const d = await t.defs.draft('https://gbfs.example.org/station_information.json');
    assert.equal(d.connector, 'rest-json');
    assert.equal(d.definition['review'], 'user-configured');
    assert.equal(d.definition['enabled'], false);
    assert.equal(typeof d.validation.ok, 'boolean');
    assert.ok(Array.isArray(d.todo) && Array.isArray(d.notes));
    assert.deepEqual(seen, ['GET https://gbfs.example.org/station_information.json redirect=manual']);

    for (const bad of [
      'http://gbfs.example.org/x.json',
      'https://127.0.0.1/x.json',
      'https://192.168.1.4/x.json',
      'https://localhost/x.json',
      'https://user:pw@gbfs.example.org/x.json',
    ])
      await assert.rejects(t.defs.draft(bad), (e: unknown) => (e as { ipcCode?: string }).ipcCode === 'DENIED', bad);
    assert.equal(seen.length, 1, 'nothing refused was fetched');
  } finally {
    t.cleanup();
  }
});

test('definitions: save writes <id>.json disabled and user-configured, never over a file or a taken id', async () => {
  const t = setup();
  try {
    t.register();
    const doc = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as Record<string, never>;
    const saved = await t.defs.save('my-bikes', { ...doc, review: 'reviewed', enabled: true } as never);
    assert.equal(saved.file, 'my-bikes.json');
    const written = JSON.parse(readFileSync(path.join(t.dir, 'my-bikes.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(written['id'], 'my-bikes');
    assert.equal(written['review'], 'user-configured', 'a file cannot declare itself reviewed');
    assert.equal(written['enabled'], false);
    assert.deepEqual(saved.listing.added, ['my-bikes']);
    assert.equal(t.host.registered.get('my-bikes')!.enabled, false);

    await assert.rejects(t.defs.save('my-bikes', doc), /already (exists|used)/);
    await assert.rejects(t.defs.save('usgs-earthquakes', doc), /already used/);
    await assert.rejects(t.defs.save('../escape', doc), /must be/);
    await assert.rejects(t.defs.save('empty-one', {}), /does not validate/);
  } finally {
    t.cleanup();
  }
});

test('definitions: without a folder there is nothing to list, draft or save', async () => {
  const host = new FakeHost();
  const defs = new ConnectorDefinitions({
    host,
    reservedIds: () => [],
    enabledSetting: () => undefined,
    persistEnabled: async () => undefined,
    logger: silentLogger,
    clock: systemClock,
    fetchImpl: (async () => {
      throw new Error('must not fetch');
    }) as typeof fetch,
  });
  assert.deepEqual(defs.load(), []);
  assert.deepEqual(defs.listing(), { folder: null, files: [] });
  await assert.rejects(defs.draft('https://example.org/x.json'), /no definition folder/);
  await assert.rejects(defs.save('x-y', {}), /no definition folder/);
});

test('definitions: two reloads at once run one after the other, so a changed file is restarted once', async () => {
  const t = setup();
  try {
    writeDef(t.dir, 'bikes.json');
    t.register();
    t.host.log.length = 0;
    writeDef(t.dir, 'bikes.json', { name: 'Renamed' });
    const [a, b] = await Promise.all([t.defs.reload(), t.defs.reload()]);
    assert.deepEqual(a.restarted, ['citibike-nyc-stations']);
    assert.deepEqual([b.added, b.removed, b.restarted], [[], [], []], 'the second saw nothing left to do');
    assert.deepEqual(t.host.log, ['unregister citibike-nyc-stations', 'register citibike-nyc-stations']);
  } finally {
    t.cleanup();
  }
});

test('definitions: a saved definition starts disabled even when its id was left switched on, and setEnabled waits for a reload', async () => {
  const t = setup();
  try {
    t.register();
    t.persisted['my-bikes'] = true;
    const doc = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as Record<string, never>;
    const saved = await t.defs.save('my-bikes', doc);
    assert.equal(t.persisted['my-bikes'], false);
    assert.equal(t.host.registered.get('my-bikes')!.enabled, false);
    assert.equal(saved.listing.files.find((f) => f.id === 'my-bikes')!.enabled, false);
    t.host.log.length = 0;
    writeDef(t.dir, 'my-bikes.json', { id: 'my-bikes', name: 'Changed' });
    await Promise.all([t.defs.reload(), t.defs.setEnabled('my-bikes.json', true)]);
    assert.deepEqual(t.host.log, ['unregister my-bikes', 'register my-bikes', 'setEnabled my-bikes true']);
  } finally {
    t.cleanup();
  }
});
