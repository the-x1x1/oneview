import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler, VISUAL_STYLE_IDS, type CameraModeState, type RenderFeature } from '@worldview/render-core';
import { ALWAYS_VISIBLE } from './horizon.js';
import { CesiumWorldRenderer } from './renderer.js';
import { createFakeCesium, fakeCanvasFactory } from './testing/fake-cesium.js';
import { VISUAL_STYLE_SHADERS } from './visual-styles.js';
import { featurePosition, followRange, orbitPitch } from './camera-modes.js';

const DEG = Math.PI / 180;

const container = () =>
  ({
    ownerDocument: { createElement: () => ({ className: '', remove() {} }) },
    appendChild() {},
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as HTMLElement;

function fakeTimers() {
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    intervals,
    setInterval: (fn: () => void, ms: number) => {
      intervals.set(next, { fn, ms });
      return next++;
    },
    clearInterval: (h: unknown) => {
      intervals.delete(h as number);
    },
  };
}

async function mounted(opts: { wall?: { now: number }; beforeMount?: (r: CesiumWorldRenderer) => void } = {}) {
  const cesium = createFakeCesium();
  const scheduler = new ManualScheduler();
  const timers = fakeTimers();
  const wall = opts.wall ?? { now: Date.parse('2026-06-21T08:24:00Z') };
  const renderer = new CesiumWorldRenderer({
    cesium,
    createCanvas: fakeCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
    wallNow: () => wall.now,
    horizon: () => ALWAYS_VISIBLE,
    timers,
  });
  const modes: CameraModeState[] = [];
  renderer.on('cameraMode', (m) => modes.push(m));
  opts.beforeMount?.(renderer);
  await renderer.mount(container());
  const viewer = cesium.viewers[0]!;
  return { cesium, renderer, scheduler, viewer, timers, wall, modes };
}

const aircraft = (id: string, extra: Partial<RenderFeature> = {}): RenderFeature => ({
  id,
  objectId: id.replace(/^obj:/, ''),
  geometry: { kind: 'point', position: { latitude: 20, longitude: 10, altitudeM: 10_000 } },
  style: { styleClass: 'aircraft' },
  interactive: true,
  priority: 50,
  layer: 'aircraft',
  ...extra,
});

// ── visual styles ────────────────────────────────────────────────────────────

test('visual styles: every style but standard has a static, cheap shader', () => {
  for (const id of VISUAL_STYLE_IDS) {
    const glsl = VISUAL_STYLE_SHADERS[id];
    if (id === 'standard') {
      assert.equal(glsl, undefined);
      continue;
    }
    assert.ok(glsl, id);
    assert.doesNotMatch(glsl, /\btime\b|czm_frameNumber|czm_currentFrustum/, `${id} does not change with time`);
    const taps = glsl.match(/\btexture\s*\(/g)?.length ?? 0;
    assert.ok(taps >= 1 && taps <= 9, `${id}: ${taps} texture reads a pixel`);
    assert.match(glsl, /out_FragColor\s*=/, id);
  }
});

test('visual styles: one stage in the scene at a time, each added and removed exactly once', async () => {
  const { renderer, viewer, cesium } = await mounted({ beforeMount: (r) => r.setVisualStyle('thermal') });
  const stages = viewer.scene.postProcessStages;
  assert.equal(stages.stages.length, 1, 'a style chosen before the globe exists is there when it mounts');
  assert.match(cesium.postProcessStages[0]!.options.fragmentShader, /wvIron/);

  const before = viewer.scene.renderRequests;
  renderer.setVisualStyle('thermal');
  assert.equal(stages.added, 1, 'the style already shown is not added again');
  renderer.setVisualStyle('crt');
  assert.equal(stages.removed, 1);
  assert.equal(stages.added, 2);
  assert.deepEqual(stages.stages, [cesium.postProcessStages[1]]);
  assert.ok(viewer.scene.renderRequests > before, 'one frame is asked for to show it');

  renderer.setVisualStyle('standard');
  assert.equal(stages.stages.length, 0, 'standard is no stage at all');
  assert.equal(stages.removed, 2);
  assert.equal(cesium.postProcessStages.length, 2, 'no stage is built for standard');
  renderer.setVisualStyle('noir');
  renderer.dispose();
  assert.equal(stages.stages.length, 0, 'disposing takes the stage out');
});

// ── day and night ────────────────────────────────────────────────────────────

test('day/night: lighting from the real Sun, the clock kept to the minute, and off puts everything back', async () => {
  const { renderer, viewer, timers, wall } = await mounted();
  const globe = viewer.scene.globe;
  const clockBefore = viewer.clock.currentTime;
  const fade = [globe.lightingFadeOutDistance, globe.lightingFadeInDistance];
  assert.equal(globe.enableLighting, false);

  const requests = viewer.scene.renderRequests;
  renderer.setDayNight(true);
  assert.equal(globe.enableLighting, true);
  assert.equal(globe.showGroundAtmosphere, false, 'ground atmosphere stays off');
  assert.ok(globe.lightingFadeOutDistance < 6_000_000, 'shaded at every altitude, as in 2D');
  assert.equal(viewer.clock.currentTime.secondsOfDay * 1000, wall.now, 'the scene clock is now');
  assert.equal(viewer.scene.renderRequests, requests + 1, 'one frame to show it');
  assert.equal(timers.intervals.size, 1);
  assert.equal([...timers.intervals.values()][0]!.ms, 60_000, 'refreshed once a minute, no oftener');

  wall.now += 60_000;
  [...timers.intervals.values()][0]!.fn();
  assert.equal(viewer.clock.currentTime.secondsOfDay * 1000, wall.now);
  assert.equal(viewer.scene.renderRequests, requests + 2);

  renderer.setDayNight(false);
  assert.equal(globe.enableLighting, false);
  assert.deepEqual([globe.lightingFadeOutDistance, globe.lightingFadeInDistance], fade);
  assert.equal(viewer.clock.currentTime, clockBefore, 'the clock is put back: the Sun and Moon in the sky too');
  assert.equal(timers.intervals.size, 0, 'no timer left running');
});

test('day/night: chosen before the globe exists, it is on when it mounts', async () => {
  const { viewer, timers } = await mounted({ beforeMount: (r) => r.setDayNight(true) });
  assert.equal(viewer.scene.globe.enableLighting, true);
  assert.equal(timers.intervals.size, 1);
});

// ── orbit ────────────────────────────────────────────────────────────────────

test('orbit: turns round the middle of the view, asking for frames only while it runs; a drag stops it', async () => {
  const { renderer, viewer, scheduler, cesium, modes } = await mounted();
  const scene = viewer.scene;
  const idle = scene.renderRequests;
  for (let i = 0; i < 5; i++) scene.preUpdate.raise(undefined);
  assert.equal(scene.renderRequests, idle, 'a still globe asks for nothing');

  renderer.setOrbit(true);
  // Requests made by the tick itself (a camera change also schedules the label pass, which
  // asks for its own frame when the scheduler runs it).
  const tick = (ms: number) => {
    scheduler.flush(ms);
    const before = scene.renderRequests;
    scene.preUpdate.raise(undefined);
    return scene.renderRequests - before;
  };
  assert.equal(tick(16), 1, 'a frame for every tick while orbiting');
  assert.equal(tick(50), 1);
  const looks = viewer.camera.lookAts;
  assert.equal(looks.length, 2);
  const h0 = (looks[0]!.offset as { heading: number }).heading;
  const h1 = (looks[1]!.offset as { heading: number }).heading;
  assert.ok(Math.abs((h1 - h0) / DEG - 0.2) < 1e-9, `4° a second: 0.2° in 50 ms (turned ${(h1 - h0) / DEG}°)`);
  assert.ok((looks[1]!.offset as { pitch: number }).pitch <= -10 * DEG, 'kept off the horizon');
  assert.equal(tick(5000), 1);
  const h2 = (viewer.camera.lookAts[2]!.offset as { heading: number }).heading;
  assert.ok(Math.abs((h2 - h1) / DEG - 0.4) < 1e-9, 'a long gap (a hidden window) turns by 0.1 s at most');

  // The operator presses on the globe.
  const released = viewer.camera.lookAtTransforms;
  cesium.handlers[0]!.fire(cesium.ScreenSpaceEventType.LEFT_DOWN, {});
  assert.deepEqual(modes.at(-1), { orbit: false, follow: null }, 'the shell is told it stopped');
  assert.equal(viewer.camera.lookAtTransforms, released + 1, 'camera back in the Earth frame, where it is');
  for (let i = 0; i < 5; i++) assert.equal(tick(16), 0, 'no frames once it has stopped');
  assert.equal(viewer.camera.lookAts.length, 3);
});

test('orbit: a wheel turn stops it too, and a flight elsewhere ends it', async () => {
  const { renderer, cesium, modes } = await mounted();
  renderer.setOrbit(true);
  cesium.handlers[0]!.fire(cesium.ScreenSpaceEventType.WHEEL, {});
  assert.equal(renderer.cameraMode.orbit, false);
  renderer.setOrbit(true);
  await renderer.flyTo({ position: { latitude: 1, longitude: 2 }, altitudeM: 5000 });
  assert.equal(renderer.cameraMode.orbit, false);
  assert.equal(modes.length, 2);
});

test('orbit pitch: never straight down or at the horizon', () => {
  assert.equal(orbitPitch(-Math.PI / 2), -89 * DEG);
  assert.equal(orbitPitch(0), -10 * DEG);
  assert.equal(orbitPitch(-40 * DEG), -40 * DEG);
});

// ── follow ───────────────────────────────────────────────────────────────────

test('follow: flies in obliquely, then keeps the moving aircraft centred as its marker moves', async () => {
  const wall = { now: Date.parse('2026-09-23T08:00:00Z') };
  const { renderer, viewer, scheduler, modes } = await mounted({ wall });
  renderer.update({
    upsert: [
      aircraft('obj:a', {
        motion: { to: { latitude: 20, longitude: 11, altitudeM: 10_000 }, fromMs: wall.now, toMs: wall.now + 60_000 },
      }),
    ],
    remove: [],
  });
  renderer.follow('obj:a', { durationMs: 1000 });
  const flight = viewer.camera.flights.at(-1)!;
  assert.deepEqual(flight.destination, { x: 10, y: 20, z: 10_000 });
  assert.ok(Math.abs(flight.offset!.pitch / DEG + 35) < 1e-9, 'an oblique view, as a flight to a selection');
  assert.equal(flight.offset!.range, 20_000, 'twice the aircraft height, closer than the camera was');
  assert.equal(flight.duration, 1);
  assert.deepEqual(viewer.camera.lookAts.at(-1)!.target, { x: 10, y: 20, z: 10_000 }, 'locked on when it lands');
  assert.deepEqual(renderer.cameraMode, { orbit: false, follow: 'obj:a' });

  wall.now += 30_000;
  scheduler.flush(2000);
  viewer.scene.preRender.raise(undefined);
  const look = viewer.camera.lookAts.at(-1)!;
  assert.deepEqual(look.target, { x: 10.5, y: 20, z: 10_000 }, 'moved with the marker');
  assert.equal('range' in look.offset, false, 'with the offset the operator has, not a new one');

  const looks = viewer.camera.lookAts.length;
  viewer.scene.preRender.raise(undefined);
  assert.equal(viewer.camera.lookAts.length, looks, 'nothing moved, the camera is not touched');

  renderer.update({ upsert: [], remove: ['obj:a'] });
  assert.deepEqual(modes.at(-1), { orbit: false, follow: null }, 'the object went: follow ends, and says so');
  assert.equal(viewer.camera.lockedTo, undefined, 'camera released');
});

test('follow: a still object costs no frames; letting go releases the camera', async () => {
  const { renderer, viewer, scheduler } = await mounted();
  renderer.update({ upsert: [aircraft('obj:b')], remove: [] });
  renderer.follow('obj:b');
  scheduler.flush(16); // the label pass the flight scheduled
  const before = viewer.scene.renderRequests;
  for (let i = 0; i < 10; i++) {
    scheduler.flush(100);
    viewer.scene.preUpdate.raise(undefined);
    viewer.scene.preRender.raise(undefined);
  }
  assert.equal(viewer.scene.renderRequests, before, 'following something still asks for no frames');
  renderer.follow(null);
  assert.equal(viewer.camera.lockedTo, undefined);
  assert.deepEqual(renderer.cameraMode, { orbit: false, follow: null });
});

test('follow: nothing to follow says so at once', async () => {
  const { renderer, modes } = await mounted();
  renderer.follow('obj:missing');
  assert.deepEqual(modes, [{ orbit: false, follow: null }]);
});

test('follow range and position helpers', () => {
  assert.equal(followRange(10_000, 5_000_000), 20_000);
  assert.equal(followRange(420_000, 5_000_000), 840_000, 'a satellite from twice its height');
  assert.equal(followRange(0, 3_000), 3_000, 'never farther than the camera already is');
  const cesium = createFakeCesium();
  const f = aircraft('obj:c', { motion: { to: { latitude: 22, longitude: 10 }, fromMs: 0, toMs: 1000 } });
  assert.deepEqual(featurePosition(cesium, f, 500), { x: 10, y: 21, z: 10_000 });
  assert.deepEqual(featurePosition(cesium, f, 99_000), { x: 10, y: 24, z: 10_000 }, 'held at MOTION_MAX_T');
  const quake = aircraft('obj:q', {
    geometry: { kind: 'point', position: { latitude: -27.5, longitude: -179.5, altitudeM: -453_000 } },
  });
  assert.deepEqual(
    featurePosition(cesium, quake, 0),
    { x: -179.5, y: -27.5, z: 0 },
    'a depth is not followed underground',
  );
});

// ── oblique fly-to ───────────────────────────────────────────────────────────

test('flyTo: with a pitch the target is centred at that pitch; without one, from straight above', async () => {
  const { renderer, viewer } = await mounted();
  await renderer.flyTo({ position: { latitude: 21.3, longitude: -157.9 }, altitudeM: 12_000 }, { pitchDegrees: -35 });
  const oblique = viewer.camera.flights.at(-1)!;
  assert.deepEqual(oblique.destination, { x: -157.9, y: 21.3, z: 0 });
  assert.ok(Math.abs(oblique.offset!.pitch / DEG + 35) < 1e-9);
  assert.equal(oblique.offset!.range, 12_000);
  await renderer.flyTo(
    { position: { latitude: -27.5, longitude: -179.5, altitudeM: -453_000 }, altitudeM: 900_000 },
    { pitchDegrees: -35 },
  );
  assert.deepEqual(
    viewer.camera.flights.at(-1)!.destination,
    { x: -179.5, y: -27.5, z: 0 },
    'a deep earthquake is looked at on the ground above it, not 453 km down',
  );
  await renderer.flyTo({ position: { latitude: 1, longitude: 2 }, altitudeM: 12_000 });
  assert.equal(viewer.camera.flights.at(-1)!.offset, undefined, 'top-down flight');
  await renderer.flyTo(
    { position: { latitude: 1, longitude: 2 }, bounds: { west: 0, south: 0, east: 4, north: 2 } },
    { pitchDegrees: -35 },
  );
  assert.equal(viewer.camera.flights.at(-1)!.offset, undefined, 'bounds are framed from above');
});

test('view: the ground at the middle of the view is reported as the focus', async () => {
  const { renderer } = await mounted();
  const view = renderer.getView();
  assert.ok(view.focus);
  assert.ok(Math.abs(view.focus.latitude - view.center.latitude) < 1e-9);
});
