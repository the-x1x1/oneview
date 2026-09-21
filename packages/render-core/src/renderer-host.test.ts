import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { RendererHost, resolveRenderMode, type HostCapabilities } from './renderer-host.js';
import { FakeWorldRenderer } from './testing/fake-renderer.js';
import { ManualScheduler } from './scheduler.js';
import { BUILT_IN_LENSES } from './lenses.js';
import type { PresentationWorker, PresentationRequest } from './presentation-worker.js';
import { InThreadPresentationWorker } from './presentation-worker.js';

function obj(id: string, type: string, lat: number, lon: number): WorldObject {
  return { id, type, sourceRefs: [], position: { latitude: lat, longitude: lon }, observedAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z', freshness: 'LIVE', confidence: 0.9, labels: { name: id }, properties: { magnitude: 5 }, provenance: { providerId: 'p', sourceName: 'p', origin: 'live', receivedAt: '2026-09-21T00:00:00.000Z' } };
}
const container = (name: string) => ({ id: name }) as unknown as HTMLElement;
const CAPS: HostCapabilities = { webgl2: true };

function harness(opts: { caps?: HostCapabilities; mode?: '2D' | '3D' | 'AUTO'; worker?: PresentationWorker; workerThreshold?: number } = {}) {
  const scheduler = new ManualScheduler();
  const r2d = new FakeWorldRenderer('2D');
  const r3d = new FakeWorldRenderer('3D', { withTerrain: true });
  const host = new RendererHost({
    renderers: { '2D': () => r2d, '3D': () => r3d },
    containers: { '2D': container('c2d'), '3D': container('c3d') },
    capabilities: opts.caps ?? CAPS,
    scheduler,
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.worker ? { worker: opts.worker } : {}),
    ...(opts.workerThreshold !== undefined ? { workerThreshold: opts.workerThreshold } : {}),
  });
  return { host, scheduler, r2d, r3d };
}

test('resolveRenderMode: explicit modes win; AUTO prefers 3D unless low power, no WebGL2 or offline-2D without terrain', () => {
  assert.equal(resolveRenderMode('2D', CAPS), '2D');
  assert.equal(resolveRenderMode('3D', { webgl2: false }), '3D');
  assert.equal(resolveRenderMode('AUTO', CAPS), '3D');
  assert.equal(resolveRenderMode('AUTO', { webgl2: false }), '2D');
  assert.equal(resolveRenderMode('AUTO', { webgl2: true, lowPower: true }), '2D');
  assert.equal(resolveRenderMode('AUTO', { webgl2: true, offline: true, offlineModePreference: '2D', terrainAvailable: false }), '2D');
  assert.equal(resolveRenderMode('AUTO', { webgl2: true, offline: true, offlineModePreference: '2D', terrainAvailable: true }), '3D');
  assert.equal(resolveRenderMode('AUTO', { webgl2: true, offline: true, offlineModePreference: '3D' }), '3D');
});

test('host: switching renderers preserves centre/zoom/selection, suspends the hidden one and resyncs features', async () => {
  const { host, scheduler, r2d, r3d } = harness({ mode: '3D' });
  const modes: string[] = [];
  host.on('modeChanged', (m) => modes.push(m.mode));
  await host.start();
  assert.equal(host.mode, '3D');
  assert.ok(r3d.container, '3D mounted');
  assert.equal(r2d.container, undefined, '2D not created until needed');

  host.setWorld({ objects: [obj('earthquake:usgs:a', 'earthquake', 10, 20), obj('earthquake:usgs:b', 'earthquake', -5, 30)] });
  host.setView({ center: { latitude: 10, longitude: 20 }, zoom: 8 });
  assert.equal(scheduler.pendingCount, 1, 'presentation coalesced to one frame');
  scheduler.flush();
  assert.equal(r3d.features.size, 2);
  host.select('earthquake:usgs:a');
  scheduler.flush();
  assert.equal(r3d.selected, 'obj:earthquake:usgs:a');
  assert.equal(r3d.features.get('obj:earthquake:usgs:a')!.style.selected, true);

  await host.setMode('2D');
  assert.deepEqual(modes, ['3D', '2D']);
  assert.equal(r3d.suspended, true, 'hidden renderer suspended');
  assert.equal(r2d.suspended, false);
  const v = r2d.getView();
  assert.equal(v.center.latitude, 10);
  assert.equal(v.center.longitude, 20);
  assert.ok(Math.abs(v.zoom - 8) < 1e-6, `zoom preserved (${v.zoom})`);
  assert.equal(r2d.selected, 'obj:earthquake:usgs:a', 'selection preserved');
  assert.equal(r2d.features.size, 2, 'incoming renderer received the full feature set');
  assert.equal(r2d.updates[0]!.upsert.length, 2);
  assert.equal(r3d.listenerCount('viewChanged'), 0, 'events from the hidden renderer are detached');
  assert.equal(r2d.listenerCount('viewChanged'), 1);

  // Switching back to the same mode is a no-op.
  const calls = r2d.calls.length;
  await host.setMode('2D');
  assert.equal(r2d.calls.length, calls);
  host.dispose();
  assert.ok(r2d.disposed && r3d.disposed);
});

test('host: diffing only sends changes; lens visibility, hover and view changes re-present', async () => {
  const { host, scheduler, r2d } = harness({ mode: '2D' });
  await host.start();
  const presented: Array<{ upserts: number; removes: number }> = [];
  host.on('presented', (p) => presented.push({ upserts: p.upserts, removes: p.removes }));
  const objects = [obj('earthquake:usgs:a', 'earthquake', 10, 20), obj('aircraft:icao24:abc', 'aircraft', 10.1, 20.1)];
  host.setWorld({ objects });
  host.setView({ center: { latitude: 10, longitude: 20 }, zoom: 12, bounds: { west: 19, south: 9, east: 21, north: 11 } });
  scheduler.flush();
  assert.equal(presented.at(-1)!.upserts, 2);
  assert.equal(r2d.updates.length, 1);

  // Same world again → no update sent to the renderer.
  host.setWorld({ objects: objects.map((o) => ({ ...o })) });
  scheduler.flush();
  assert.deepEqual(presented.at(-1), { upserts: 0, removes: 0 });
  assert.equal(r2d.updates.length, 1, 'no renderer update for an unchanged world');

  // One object moves → exactly one upsert.
  const moved = [{ ...objects[0]!, position: { latitude: 10.05, longitude: 20 } }, objects[1]!];
  host.setWorld({ objects: moved });
  scheduler.flush();
  assert.deepEqual(presented.at(-1), { upserts: 1, removes: 0 });

  // Aviation lens hides earthquakes → one remove.
  host.setLens(BUILT_IN_LENSES.find((l) => l.id === 'aviation'));
  scheduler.flush();
  assert.deepEqual(presented.at(-1), { upserts: 0, removes: 1 });
  assert.equal(r2d.features.size, 1);

  // Hover from the renderer re-presents with the hovered flag.
  r2d.emit('hover', { featureId: 'obj:aircraft:icao24:abc', objectId: 'aircraft:icao24:abc', position: { latitude: 10.1, longitude: 20.1 }, screen: { x: 1, y: 1 } });
  assert.equal(host.presentationScheduled, true);
  scheduler.flush();
  assert.equal(r2d.features.get('obj:aircraft:icao24:abc')!.style.hovered, true);

  // View change from the renderer flows out as viewChanged and re-presents at the new LOD.
  const views: number[] = [];
  host.on('viewChanged', (v) => views.push(v.zoom));
  r2d.setView({ zoom: 1, bounds: { west: -180, south: -90, east: 180, north: 90 } });
  r2d.emit('viewChanged', r2d.getView());
  scheduler.flush();
  assert.deepEqual(views, [1]);
  assert.ok([...r2d.features.values()].every((f) => f.geometry.kind === 'density'), 'aircraft aggregated at global zoom');
  host.dispose();
});

test('host: presentation runs on the worker above the threshold and stale replies never override newer ones', async () => {
  const seen: number[] = [];
  const gates: Array<() => void> = [];
  const inner = new InThreadPresentationWorker();
  const worker: PresentationWorker = {
    present: (req: PresentationRequest) => { seen.push(req.objects.length); return new Promise((resolve) => { gates.push(() => resolve(inner.present(req))); }); },
    dispose: () => { /* noop */ },
  };
  const { host, scheduler, r2d } = harness({ mode: '2D', worker, workerThreshold: 3 });
  await host.start();
  const offThread: boolean[] = [];
  host.on('presented', (p) => offThread.push(p.offThread));
  host.setView({ center: { latitude: 0, longitude: 0 }, zoom: 1, bounds: { west: -180, south: -90, east: 180, north: 90 } });
  host.setWorld({ objects: [obj('earthquake:usgs:1', 'earthquake', 1, 1), obj('earthquake:usgs:2', 'earthquake', 2, 2)] });
  scheduler.flush();
  assert.deepEqual(offThread, [false]);
  assert.deepEqual(seen, [], 'small sets stay in-thread');

  const many = Array.from({ length: 5 }, (_, i) => obj(`earthquake:usgs:${i}`, 'earthquake', i, i));
  host.setWorld({ objects: many });
  scheduler.flush();
  assert.deepEqual(seen, [5], 'large set goes to the worker');
  assert.equal(gates.length, 1);
  // A second frame while the first is in flight marks dirty instead of a second request.
  host.setWorld({ objects: many.slice(0, 4) });
  scheduler.flush();
  assert.equal(seen.length, 1, 'no concurrent worker request');
  gates[0]!();
  await new Promise((r) => setImmediate(r));
  assert.equal(r2d.features.size, 5, 'first result applied');
  assert.equal(scheduler.pendingCount, 1, 'dirty world re-presented after the in-flight run');
  scheduler.flush();
  gates[1]!();
  await new Promise((r) => setImmediate(r));
  assert.equal(r2d.features.size, 4);
  assert.deepEqual(offThread.slice(-2), [true, true]);
  host.dispose();
});

test('host: AUTO re-resolves on capability change; basemap/terrain/attribution follow the active renderer', async () => {
  const { host, r2d, r3d } = harness({ mode: 'AUTO' });
  await host.start();
  assert.equal(host.mode, '3D');
  await host.setBasemap({ kind: 'cesium-natural-earth', id: 'natural-earth', attribution: 'Natural Earth II' });
  await host.setTerrain({ kind: 'ellipsoid' });
  host.setAttribution([{ id: 'usgs', text: 'USGS', onScreen: false }]);
  assert.equal(r3d.basemap?.id, 'natural-earth');
  assert.deepEqual(r3d.terrain, { kind: 'ellipsoid' });
  await host.setBasemap({ kind: 'pmtiles', id: 'pack', url: 'file:///pack.pmtiles', styleId: 'worldview-dark', attribution: 'OSM' }, '2D');
  assert.equal(r3d.basemap?.id, 'natural-earth', 'a 2D basemap does not touch the 3D renderer');

  host.setCapabilities({ webgl2: true, lowPower: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(host.mode, '2D');
  assert.equal(r2d.basemap?.id, 'pack', 'remembered 2D basemap applied on switch');
  assert.deepEqual(r2d.attribution.map((a) => a.id), ['usgs']);
  assert.equal(r3d.suspended, true);

  host.suspend();
  assert.equal(r2d.suspended, true);
  host.resume();
  assert.equal(r2d.suspended, false);
  host.dispose();
});
