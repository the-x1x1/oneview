import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USGS_NORMAL_FIXTURE } from '../../src/renderer/demo/fixtures/usgs-normal.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('the demo fixture module is identical to fixtures/usgs/normal.geojson', () => {
  const source = JSON.parse(readFileSync(path.join(root, 'fixtures', 'usgs', 'normal.geojson'), 'utf8'));
  assert.deepEqual(USGS_NORMAL_FIXTURE, source, 'run `node tools/dev/sync-demo-fixtures.mjs`');
});
