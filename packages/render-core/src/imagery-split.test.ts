import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RasterOverlay } from '@worldview/world-model';
import {
  clampSplit,
  defaultSplit,
  fadeOpacity,
  reconcileSplit,
  splitCandidates,
  splitSideFor,
  stepSplit,
  type ImagerySplit,
} from './imagery-split.js';

const overlay = (providerId: string, id = `${providerId}:layer`, extra: Partial<RasterOverlay> = {}): RasterOverlay =>
  ({
    kind: 'xyz',
    id,
    providerId,
    name: `${providerId} name`,
    attribution: 'test',
    url: 'https://tiles.example.org/{z}/{x}/{y}.png',
    ...extra,
  }) as RasterOverlay;

test('clampSplit: finite and within the map', () => {
  assert.equal(clampSplit(0.3), 0.3);
  assert.equal(clampSplit(-1), 0);
  assert.equal(clampSplit(2), 1);
  assert.equal(clampSplit(Number.NaN), 0.5);
  assert.equal(clampSplit(Number.POSITIVE_INFINITY), 0.5);
});

test('splitSideFor: by source; the same source on both sides is drawn whole', () => {
  const split: ImagerySplit = { left: 'a', right: 'b', position: 0.5 };
  assert.equal(splitSideFor(split, 'a'), 'left');
  assert.equal(splitSideFor(split, 'b'), 'right');
  assert.equal(splitSideFor(split, 'c'), 'none');
  assert.equal(splitSideFor(null, 'a'), 'none');
  assert.equal(splitSideFor({ left: 'a', right: 'a', position: 0.5 }, 'a'), 'none');
  assert.equal(splitSideFor({ left: null, right: 'b', position: 0.5 }, 'b'), 'right');
});

test('fadeOpacity: the 2D cross-fade follows the divider', () => {
  const split: ImagerySplit = { left: 'a', right: 'b', position: 0.25 };
  assert.equal(fadeOpacity(split, 'b', 1), 0.75, 'three quarters of the map is right of the divider');
  assert.equal(fadeOpacity(split, 'a', 0.8), 0.2);
  assert.equal(fadeOpacity(split, 'c', 0.6), 0.6, 'a source not compared keeps its opacity');
  assert.equal(fadeOpacity(null, 'b', 0.6), 0.6);
  assert.equal(fadeOpacity({ ...split, position: 0 }, 'b', 1), 1);
  assert.equal(fadeOpacity({ ...split, position: 1 }, 'b', 1), 0);
});

test('stepSplit: arrows by 1 %, Shift by 5 %, Home and End to the edges', () => {
  assert.equal(stepSplit(0.5, 'ArrowRight', false), 0.51);
  assert.equal(stepSplit(0.5, 'ArrowLeft', true), 0.45);
  assert.equal(stepSplit(0.99, 'ArrowRight', true), 1);
  assert.equal(stepSplit(0.3, 'Home', false), 0);
  assert.equal(stepSplit(0.3, 'End', false), 1);
  assert.equal(stepSplit(0.3, 'Enter', false), undefined);
});

test('splitCandidates: one entry per source, basemaps left out, drawing order kept', () => {
  const list = [
    overlay('snpp', 'snpp:layer:2026-09-27'),
    overlay('snpp', 'snpp:layer:2026-09-28'),
    overlay('topo', 'topo:map', { role: 'basemap' }),
    overlay('noaa20'),
  ];
  assert.deepEqual(splitCandidates(list), [
    { providerId: 'snpp', name: 'snpp name' },
    { providerId: 'noaa20', name: 'noaa20 name' },
  ]);
});

test('defaultSplit: the last two sources, or one against the map, or nothing', () => {
  assert.equal(defaultSplit([]), undefined);
  assert.deepEqual(defaultSplit([{ providerId: 'a', name: 'A' }]), { left: null, right: 'a', position: 0.5 });
  assert.deepEqual(
    defaultSplit([
      { providerId: 'a', name: 'A' },
      { providerId: 'b', name: 'B' },
      { providerId: 'c', name: 'C' },
    ]),
    { left: 'b', right: 'c', position: 0.5 },
  );
});

test('reconcileSplit: a side whose source went becomes the map; unchanged is the same object', () => {
  const split: ImagerySplit = { left: 'a', right: 'b', position: 0.4 };
  assert.equal(
    reconcileSplit(split, [
      { providerId: 'a', name: 'A' },
      { providerId: 'b', name: 'B' },
    ]),
    split,
  );
  assert.deepEqual(reconcileSplit(split, [{ providerId: 'b', name: 'B' }]), { left: null, right: 'b', position: 0.4 });
});
