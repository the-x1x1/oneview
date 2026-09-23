import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GAP_MS,
  MAX_PROFILE_SAMPLES,
  extendTrack,
  profilePath,
  replaySpeedFor,
  sampleAt,
  trackProfile,
} from './track-profile.js';
import type { TrackPoint } from '../store/types.js';

const T0 = Date.parse('2026-09-23T04:00:00.000Z');
/** Due east along the equator at `mps`, one fix every `stepMs`. */
function eastbound(n: number, mps: number, stepMs = 10_000, from = T0, alt?: (i: number) => number): TrackPoint[] {
  const degPerM = 360 / 40_030_174;
  return Array.from({ length: n }, (_, i) => ({
    observedAt: new Date(from + i * stepMs).toISOString(),
    latitude: 0,
    longitude: 10 + i * (stepMs / 1000) * mps * degPerM,
    ...(alt ? { altitudeM: alt(i) } : {}),
  }));
}

test('track profile: ground speed is derived from positions, and altitude is the recorded one', () => {
  const p = trackProfile(eastbound(60, 230, 10_000, T0, (i) => 3000 + i * 100));
  assert.ok(p);
  assert.equal(p.startMs, T0);
  assert.equal(p.endMs, T0 + 590_000);
  assert.equal(p.samples[0]!.speedMps, undefined, 'no speed before a second fix');
  for (const s of p.samples.slice(1)) assert.ok(Math.abs(s.speedMps! - 230) < 1, `~230 m/s, got ${s.speedMps}`);
  assert.deepEqual(p.altitude, { min: 3000, max: 8900 });
  assert.ok(p.speed && Math.abs(p.speed.min - 230) < 1 && Math.abs(p.speed.max - 230) < 1);
});

test('track profile: one bad fix does not become a spike, and a gap breaks the line', () => {
  const track = eastbound(20, 200);
  // Fix 10 jumps half a degree north and back: ~55 km in ten seconds.
  track[10] = { ...track[10]!, latitude: 0.5 };
  const p = trackProfile(track)!;
  const speeds = p.samples.map((s) => s.speedMps ?? 0);
  assert.ok(
    speeds.slice(1).every((v) => Math.abs(v - 200) < 1),
    `no spike: ${speeds.map((v) => Math.round(v)).join(',')}`,
  );

  const gapped = [...eastbound(5, 200), ...eastbound(5, 200, 10_000, T0 + 40_000 + GAP_MS + 1)];
  const g = trackProfile(gapped)!;
  assert.equal(g.samples[5]!.breakBefore, true);
  assert.equal(g.samples[5]!.speedMps, undefined, 'no speed across the gap');
  const d = profilePath(g, (s) => s.speedMps, g.speed!, 1000, 100);
  assert.equal((d.match(/M/g) ?? []).length, 2, 'two sub-paths');
});

test('track profile: long tracks are thinned for drawing; lookup and replay speed', () => {
  const p = trackProfile(eastbound(8_640, 200, 10_000))!;
  assert.ok(p.samples.length <= MAX_PROFILE_SAMPLES + 1);
  assert.equal(p.samples.at(-1)!.t, p.endMs, 'the last fix is kept');
  assert.equal(sampleAt(p, p.startMs - 1).t, p.startMs);
  assert.equal(sampleAt(p, p.endMs + 1).t, p.endMs);
  assert.equal(replaySpeedFor(5 * 60_000), 5);
  assert.equal(replaySpeedFor(20 * 60_000), 20);
  assert.equal(replaySpeedFor(3_600_000), 60, 'an hour at 60x is a minute');
  assert.equal(replaySpeedFor(24 * 3_600_000), 60);
  assert.equal(trackProfile(eastbound(1, 200)), undefined, 'one fix is not a profile');
});

test('extendTrack: a later position of the selected object is appended; an earlier one is not', () => {
  const track = eastbound(3, 200);
  const later = {
    observedAt: new Date(T0 + 30_000).toISOString(),
    position: { latitude: 0, longitude: 11, altitudeM: 900 },
  };
  const grown = extendTrack(track, later)!;
  assert.equal(grown.length, 4);
  assert.deepEqual(grown.at(-1), { observedAt: later.observedAt, latitude: 0, longitude: 11, altitudeM: 900 });
  assert.equal(extendTrack(track, { ...later, observedAt: new Date(T0).toISOString() }), undefined, 'replayed');
  assert.equal(extendTrack(track, { observedAt: later.observedAt }), undefined, 'no position');
  const far = { ...later, observedAt: new Date(T0 + 600_000).toISOString() };
  assert.equal(extendTrack(eastbound(5, 200), far, 5)!.length, 5, 'bounded');
});
