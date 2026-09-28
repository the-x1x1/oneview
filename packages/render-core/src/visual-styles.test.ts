import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVisualStyleId, nextVisualStyle, VISUAL_STYLE_IDS } from './visual-styles.js';

test('visual styles: V cycles forward through every style and wraps; Shift+V goes back', () => {
  const seen = [];
  let id = nextVisualStyle('noir');
  for (let i = 0; i < VISUAL_STYLE_IDS.length; i++) {
    seen.push(id);
    id = nextVisualStyle(id);
  }
  assert.deepEqual(seen, [...VISUAL_STYLE_IDS], 'noir wraps to standard, then in order');
  assert.equal(nextVisualStyle('standard', -1), 'noir');
  assert.equal(nextVisualStyle('thermal', -1), 'night-vision');
  assert.equal(nextVisualStyle(undefined), 'night-vision', 'no setting yet counts as standard');
});

test('visual styles: ids are recognised, anything else is not', () => {
  assert.ok(isVisualStyleId('crt'));
  assert.equal(isVisualStyleId('sepia'), false);
  assert.equal(isVisualStyleId(3), false);
});
