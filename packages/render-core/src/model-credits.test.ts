import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_CREDITS, modelCreditLines, modelCreditText } from './model-credits.js';

test('modelCreditText: title, author, the licence and that it was modified', () => {
  assert.equal(modelCreditText(MODEL_CREDITS.airliner), '3D model “boeing 747” by zairiq-123, CC BY 4.0, modified');
});

test('modelCreditLines: one line per model file, in the order drawn; none for none', () => {
  assert.deepEqual(modelCreditLines([]), []);
  const lines = modelCreditLines(['ship', 'airliner', 'airliner']);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^3D model “/);
  assert.equal(lines[1], modelCreditText(MODEL_CREDITS.airliner));
});
