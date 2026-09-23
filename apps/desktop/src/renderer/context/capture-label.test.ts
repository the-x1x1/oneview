import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureLabel, snapshotPollMs, stormMotion, stormWinds } from './sections.js';

test('camera still label: the image’s own time and age, or plainly the fetch time', () => {
  const at = '2026-09-23T06:00:00.000Z';
  const fetched = Date.parse(at) + 6 * 60_000;
  assert.equal(captureLabel({ capturedAt: null }), '');
  assert.match(
    captureLabel({ capturedAt: at, source: 'upstream', fetchedAtMs: fetched }),
    /^Posted .* · 6m old when fetched$/,
  );
  assert.match(
    captureLabel({ capturedAt: at, source: 'upstream', fetchedAtMs: Date.parse(at) + 20_000 }),
    /^Posted [^·]*$/,
    'under a minute old: no age',
  );
  assert.match(
    captureLabel({ capturedAt: at, source: 'fetched', fetchedAtMs: fetched }),
    /^Fetched .* publishes no capture time$/,
  );
  assert.match(captureLabel({ capturedAt: at }), /^Captured /, 'a user camera makes the image when asked');
});

test('an open snapshot refreshes at the camera’s own interval, kept between 30 s and 10 min', () => {
  const cam = (refreshSeconds?: number) =>
    ({ properties: refreshSeconds === undefined ? {} : { refreshSeconds } }) as unknown as Parameters<
      typeof snapshotPollMs
    >[0];
  assert.equal(snapshotPollMs(cam(120)), 120_000, 'Hong Kong: every two minutes');
  assert.equal(snapshotPollMs(cam(5)), 30_000, 'never faster than every 30 s');
  assert.equal(snapshotPollMs(cam(3600)), 600_000, 'never slower than every 10 min');
  assert.equal(snapshotPollMs(cam()), undefined, 'no stated interval: the button only');
});

test('a storm reads in NHC’s units: knots with mph and category, motion as a compass point', () => {
  assert.equal(stormWinds(60, 'TS'), '60 kt (69 mph)');
  assert.equal(stormWinds(100, 'HU'), '100 kt (115 mph) · Category 3');
  assert.equal(stormWinds(undefined, 'HU'), undefined);
  assert.equal(stormMotion(70, 9), 'ENE (70°) at 9 mph (14 km/h)');
  assert.equal(stormMotion(300, 0), 'Stationary');
  assert.equal(stormMotion(undefined, 9), undefined);
});

test('a camera offers video only when its catalogue publishes some; otherwise it says it is stills', async () => {
  const { cameraVideoKind, stillsOnlyNote, canPlayHlsNatively } = await import('./sections.js');
  const cam = (properties: Record<string, unknown>, media?: Array<{ kind: string; ref: string }>) =>
    ({ properties, ...(media ? { media } : {}) }) as unknown as Parameters<typeof cameraVideoKind>[0];
  assert.equal(cameraVideoKind(cam({ streamKind: 'hls' })), 'hls', 'Caltrans, Iowa');
  assert.equal(cameraVideoKind(cam({ streamKind: 'mjpeg' })), 'mjpeg', 'Taiwan');
  assert.equal(cameraVideoKind(cam({ streamKind: 'clip' })), 'clip', 'TfL');
  assert.equal(cameraVideoKind(cam({}, [{ kind: 'stream', ref: 'a1b2c3d4e5f6' }])), 'stream', 'a registered camera');
  assert.equal(cameraVideoKind(cam({ streamKind: 'rtsp' })), undefined, 'nothing this build knows');
  assert.equal(cameraVideoKind(cam({}, [{ kind: 'snapshot', ref: 'public:drivebc:1' }])), undefined, 'DriveBC: stills');
  assert.match(stillsOnlyNote(cam({ refreshSeconds: 120 })), /no video; a new picture about every 2 minutes/);
  assert.match(stillsOnlyNote(cam({ refreshSeconds: 60 })), /every 60 seconds/);
  assert.equal(stillsOnlyNote(cam({})), 'Stills only — this camera publishes no video.');
  const doc = (answer: string) => ({ createElement: () => ({ canPlayType: () => answer }) }) as never;
  assert.equal(canPlayHlsNatively(doc('maybe')), true);
  assert.equal(canPlayHlsNatively(doc('')), false);
  assert.equal(canPlayHlsNatively(undefined), false);
});
