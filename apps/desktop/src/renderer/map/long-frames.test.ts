import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkName, summariseLongFrame } from './long-frames.js';

test('long frame: the longest script names its chunk and entry kind; layout is frame plus forced', () => {
  const s = summariseLongFrame({
    startTime: 1000,
    duration: 150,
    renderStart: 1110,
    styleAndLayoutStart: 1130,
    scripts: [
      {
        duration: 30,
        invokerType: 'resolve-promise',
        sourceURL: 'worldview://app/assets/index-B7xQ2k9a.js',
        sourceCharPosition: 1234,
      },
      {
        duration: 95,
        invokerType: 'user-callback',
        invoker: 'FrameRequestCallback',
        sourceURL: 'worldview://app/assets/maplibre-Cx81aQzP.js?v=1',
        sourceCharPosition: 88_000,
        forcedStyleAndLayoutDuration: 4,
      },
    ],
  });
  assert.deepEqual(s, {
    durationMs: 150,
    scriptMs: 125,
    layoutMs: 24,
    top: 'maplibre:callback 95ms',
    topPos: 88_000,
    blockingMs: 0,
    workMs: 110,
    renderMs: 20,
  });
  const idle = summariseLongFrame({ startTime: 0, duration: 60 });
  assert.equal(idle.top, 'no-script');
  assert.equal(idle.workMs, 60, 'no rendering update: the whole frame was tasks');
  assert.equal(idle.renderMs, 0);
  assert.equal(summariseLongFrame({ startTime: 0, duration: 120, blockingDuration: 45 }).blockingMs, 45);
  assert.equal(chunkName(undefined), 'unknown');
  assert.equal(chunkName('https://x/assets/cesium-AbCdEf12.js'), 'cesium');
  assert.ok(!JSON.stringify(s).includes('worldview://'), 'no URLs leave the module');
});
