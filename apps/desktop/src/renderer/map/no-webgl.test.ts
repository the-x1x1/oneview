import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noWebGlMessage } from './gpu-info.js';

test('no WebGL2: the map says what is missing, that the rest still works, and where to look', () => {
  const linux = noWebGlMessage('linux');
  assert.match(linux, /WebGL2/);
  assert.match(linux, /Search, sources, the feed, history and exports still work/);
  assert.match(linux, /Mesa/);
  assert.match(linux, /Diagnostics/);
  const win = noWebGlMessage('win32');
  assert.doesNotMatch(win, /Mesa/, 'Mesa is Linux advice');
  assert.match(win, /graphics driver/);
  assert.equal(noWebGlMessage(undefined), win, 'the browser demo has no platform; it gets the general advice');
});
