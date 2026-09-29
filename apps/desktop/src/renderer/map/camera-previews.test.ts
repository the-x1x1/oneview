import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { decodableVideo, previewTitle } from './camera-previews.js';

/** An invented camera: only the fields read here. */
const cam = (properties: Record<string, unknown>, media?: WorldObject['media']): WorldObject =>
  ({ id: 'camera:x:1', type: 'camera', properties, labels: {}, ...(media ? { media } : {}) }) as unknown as WorldObject;

test('camera previews: only MJPEG, or HLS where this window plays it, counts as a live decoder', () => {
  assert.equal(decodableVideo(cam({ streamKind: 'mjpeg' }), false), true);
  assert.equal(decodableVideo(cam({ streamKind: 'hls' }), true), true);
  assert.equal(decodableVideo(cam({ streamKind: 'hls' }), false), false, 'HLS Chromium cannot play: stills');
  assert.equal(decodableVideo(cam({ streamKind: 'clip' }), true), false, 'a recorded clip is shown as stills');
  assert.equal(decodableVideo(cam({}), true), false, 'stills-only camera');
});

test("camera previews: a tile's tooltip names the camera, what the picture is and whose it is", () => {
  const live = previewTitle('I-5 at Main St', 'live', 'Washington State DOT');
  assert.deepEqual(live.split('\n'), [
    'I-5 at Main St',
    'Live video, as the agency serves it',
    'Washington State DOT',
    'Click to open the camera',
  ]);
  assert.ok(previewTitle('Cam', 'still', undefined).includes('Latest still'));
  assert.ok(!previewTitle('Cam', 'still', undefined).includes('undefined'));
});
