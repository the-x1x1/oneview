import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkerUrl } from './maplibre-module.js';

test('applyWorkerUrl: MapLibre is told where its worker is, through the default export too', () => {
  // maplibre-gl 6 finds its worker from `import.meta.url`, and only for http(s) URLs. Under
  // `worldview://app` it falls back to an empty string and loads the page itself as the
  // worker script, so the packaged app must set the URL explicitly — before the first map,
  // because the worker pool is created on first use and never re-reads it.
  const seen: string[] = [];
  const direct = { setWorkerUrl: (u: string) => void seen.push(`direct:${u}`) };
  applyWorkerUrl(direct as never, 'worldview://app/maplibre/maplibre-gl-worker.mjs');
  assert.deepEqual(seen, ['direct:worldview://app/maplibre/maplibre-gl-worker.mjs']);

  // Under Node's ESM/CJS interop the members live on `default`; calling the namespace's
  // own (undefined) setter would throw, which is the same trap `adaptMapLibreModule` avoids.
  const wrapped = { default: { setWorkerUrl: (u: string) => void seen.push(`default:${u}`) } };
  applyWorkerUrl(wrapped as never, 'http://127.0.0.1:5173/maplibre/maplibre-gl-worker.mjs');
  assert.equal(seen.at(-1), 'default:http://127.0.0.1:5173/maplibre/maplibre-gl-worker.mjs');
});

test('applyWorkerUrl: a URL that is not the worker script is refused, not handed on', () => {
  // The failure being fixed is a worker URL that resolves to the page. Handing MapLibre the
  // page, a directory or a stylesheet reproduces it exactly, so it is refused here instead.
  const module = { setWorkerUrl: () => assert.fail('must not be called') };
  for (const bad of ['worldview://app/', 'worldview://app/maplibre/', 'worldview://app/maplibre/maplibre-gl.css'])
    assert.throws(() => applyWorkerUrl(module as never, bad), TypeError, bad);
  assert.throws(() => applyWorkerUrl(module as never, ''), 'an empty string is not a URL at all');
});
