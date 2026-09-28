import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LIVE_PREVIEWS,
  MAX_PREVIEW_TILES,
  PREVIEW_EDGES,
  PREVIEW_GEOMETRY,
  choosePreviews,
  layoutTile,
  samePicks,
  tileHeight,
  tilesOverlap,
  type PreviewCandidate,
} from './camera-preview-layout.js';

const vp = { width: 1200, height: 800 };
const h = tileHeight(PREVIEW_GEOMETRY);

test('preview layout: above the camera, below it near the top, pushed inside the map and then unanchored', () => {
  const mid = layoutTile({ x: 600, y: 400 }, vp);
  assert.deepEqual(mid, {
    x: 600 - PREVIEW_GEOMETRY.width / 2,
    y: 400 - h - PREVIEW_GEOMETRY.gap,
    flipped: false,
    anchored: true,
  });
  const top = layoutTile({ x: 600, y: 60 }, vp);
  assert.equal(top.flipped, true);
  assert.equal(top.y, 60 + PREVIEW_GEOMETRY.gap);
  assert.equal(top.anchored, true);
  const edge = layoutTile({ x: 5, y: 400 }, vp);
  assert.equal(edge.x, PREVIEW_EDGES.side, 'kept inside the map');
  assert.equal(edge.anchored, false, 'off its camera, so no stem');
});

test('preview layout: tiles that would overlap are detected, neighbours that do not are not', () => {
  const a = layoutTile({ x: 600, y: 400 }, vp);
  assert.equal(tilesOverlap(a, layoutTile({ x: 640, y: 410 }, vp)), true);
  assert.equal(tilesOverlap(a, layoutTile({ x: 600 + PREVIEW_GEOMETRY.width + 20, y: 400 }, vp)), false);
});

test('preview choice: nearest the middle first, no overlaps, at most six tiles and two decoding video', () => {
  // An invented grid of cameras, every one with video.
  const candidates: PreviewCandidate[] = [];
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 4; j++)
      candidates.push({ id: `c${i}${j}`, point: { x: 100 + i * 200, y: 200 + j * 170 }, video: true });
  const picks = choosePreviews(candidates, vp);
  assert.equal(picks.length, MAX_PREVIEW_TILES);
  assert.equal(picks.filter((p) => p.mode === 'live').length, MAX_LIVE_PREVIEWS);
  assert.ok(
    picks.slice(MAX_LIVE_PREVIEWS).every((p) => p.mode === 'still'),
    'the rest are stills, not dropped',
  );
  const boxes = picks.map((p) => layoutTile(candidates.find((c) => c.id === p.id)!.point, vp));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) assert.equal(tilesOverlap(boxes[i]!, boxes[j]!), false);
  // The live ones are the nearest the middle.
  const d = (id: string) => {
    const p = candidates.find((c) => c.id === id)!.point;
    return (p.x - 600) ** 2 + (p.y - 400) ** 2;
  };
  assert.ok(Math.max(...picks.filter((p) => p.mode === 'live').map((p) => d(p.id))) <= d(picks.at(-1)!.id));
});

test('preview choice: a camera without video is a still; a crowd in one spot gets one tile', () => {
  const crowd: PreviewCandidate[] = [
    { id: 'a', point: { x: 600, y: 400 }, video: false },
    { id: 'b', point: { x: 604, y: 402 }, video: true },
    { id: 'c', point: { x: 602, y: 398 }, video: true },
  ];
  const picks = choosePreviews(crowd, vp);
  assert.deepEqual(picks, [{ id: 'a', mode: 'still' }], 'the one in the middle, stills only');
  assert.deepEqual(choosePreviews(crowd.slice(1), vp), [{ id: 'c', mode: 'live' }]);
  assert.deepEqual(choosePreviews([], vp), []);
  assert.equal(samePicks(picks, [{ id: 'a', mode: 'still' }]), true);
  assert.equal(samePicks(picks, [{ id: 'a', mode: 'live' }]), false);
});
