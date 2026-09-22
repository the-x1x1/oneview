import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import {
  InThreadPresentationWorker,
  PortPresentationWorker,
  servePresentation,
  type PortLike,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from './presentation-worker.js';
import { FrameCoalescer, ManualScheduler } from './scheduler.js';
import type { ViewState } from './contract.js';

function obj(id: string, lat: number, lon: number): WorldObject {
  return {
    id,
    type: 'earthquake',
    sourceRefs: [],
    position: { latitude: lat, longitude: lon },
    observedAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    freshness: 'LIVE',
    confidence: 0.9,
    labels: { title: id },
    properties: { magnitude: 5 },
    provenance: { providerId: 'p', sourceName: 'p', origin: 'live', receivedAt: '2026-09-21T00:00:00.000Z' },
  };
}
const view: ViewState = {
  center: { latitude: 0, longitude: 0 },
  altitudeM: 20_000_000,
  zoom: 1,
  headingDegrees: 0,
  pitchDegrees: -90,
  bounds: { west: -180, south: -90, east: 180, north: 90 },
};

/** A pair of ports wired to each other, delivering asynchronously like a real MessagePort. */
function portPair(): {
  host: PortLike<WorkerRequestMessage, WorkerResponseMessage>;
  worker: PortLike<WorkerResponseMessage, WorkerRequestMessage>;
  closed: string[];
} {
  const hostListeners = new Set<(m: WorkerResponseMessage) => void>();
  const workerListeners = new Set<(m: WorkerRequestMessage) => void>();
  const closed: string[] = [];
  return {
    closed,
    host: {
      postMessage: (m) => queueMicrotask(() => workerListeners.forEach((l) => l(m))),
      onMessage: (l) => {
        hostListeners.add(l);
        return () => hostListeners.delete(l);
      },
      close: () => closed.push('host'),
    },
    worker: {
      postMessage: (m) => queueMicrotask(() => hostListeners.forEach((l) => l(m))),
      onMessage: (l) => {
        workerListeners.add(l);
        return () => workerListeners.delete(l);
      },
    },
  };
}

test('presentation worker: in-thread and port implementations produce identical results', async () => {
  const objects = [obj('earthquake:usgs:a', 10, 10), obj('earthquake:usgs:b', -20, 30)];
  const inThread = await new InThreadPresentationWorker().present({ objects, view, visibleTypes: ['earthquake'] });
  const ports = portPair();
  const stop = servePresentation(ports.worker);
  const client = new PortPresentationWorker(ports.host);
  const remote = await client.present({ objects, view, visibleTypes: ['earthquake'] });
  assert.deepEqual(remote, inThread);
  assert.equal(remote.upsert.length, 2);
  stop();
  client.dispose();
  assert.deepEqual(ports.closed, ['host']);
});

test('presentation worker: errors travel back as rejections and disposal rejects pending requests', async () => {
  const ports = portPair();
  servePresentation(ports.worker);
  const client = new PortPresentationWorker(ports.host);
  // A non-iterable object list makes presentObjects throw; the worker must report, not hang.
  await assert.rejects(client.present({ objects: null as unknown as WorldObject[], view }), /not iterable/);
  const pending = client.present({ objects: [], view });
  client.dispose();
  await assert.rejects(pending, /disposed/);
});

test('frame coalescer: many schedule() calls run once per flushed frame', () => {
  const s = new ManualScheduler();
  let runs = 0;
  const c = new FrameCoalescer(s, () => {
    runs++;
  });
  c.schedule();
  c.schedule();
  c.schedule();
  assert.equal(s.pendingCount, 1);
  assert.equal(s.flush(), 1);
  assert.equal(runs, 1);
  c.schedule();
  c.cancel();
  assert.equal(s.flush(), 0);
  assert.equal(runs, 1);
});
