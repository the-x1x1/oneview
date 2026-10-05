import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VISUAL_STYLE_IDS as SETTINGS_STYLE_IDS } from '@worldview/ipc-contract';
import { VISUAL_STYLE_IDS as RENDERER_STYLE_IDS } from '@worldview/render-core';
import {
  formatAltitude,
  formatDecimal,
  formatDms,
  formatGridReference,
  formatHeading,
  formatPitch,
  formatUtc,
  formatZoom,
  wrapLongitude,
} from './hud-format.js';
import { VISUAL_STYLE_NAMES } from '../store/display.js';

test('the renderers draw exactly the visual styles the settings can hold', () => {
  // render-core cannot import the IPC contract, so the list is written twice; this keeps
  // them one list. A style added to the settings and not to the renderers would be a
  // setting that silently does nothing.
  assert.deepEqual([...RENDERER_STYLE_IDS], [...SETTINGS_STYLE_IDS]);
  assert.deepEqual(Object.keys(VISUAL_STYLE_NAMES).sort(), [...SETTINGS_STYLE_IDS].sort(), 'every style has a name');
});

test('HUD: coordinates in decimal degrees and DMS, hemispheres, fixed width', () => {
  assert.equal(formatDecimal(21.307, -157.858306), '21.30700° N  157.85831° W');
  assert.equal(formatDecimal(-33.8688, 151.2093), '33.86880° S  151.20930° E');
  assert.equal(formatDecimal(1.5, 2.5).length, formatDecimal(-81.25, -179.5).length, 'no jumping as it changes');
  assert.equal(formatDms(21.307, -157.858306), '21°18′25.2″ N  157°51′29.9″ W');
  assert.equal(formatDms(-0.5, 0.25), ' 0°30′00.0″ S    0°15′00.0″ E');
  assert.equal(
    formatDms(10.99999, 20),
    '11°00′00.0″ N   20°00′00.0″ E',
    'seconds that round up carry into minutes and degrees',
  );
  assert.equal(formatDms(1, 2).length, formatDms(-89.9, -179.9).length);
  assert.equal(wrapLongitude(190), -170, 'the 2D map past the antimeridian');
  assert.equal(formatDecimal(0, 540), ' 0.00000° N  180.00000° W');
});

test('HUD: altitude, zoom, heading, pitch and the UTC clock', () => {
  assert.equal(formatAltitude(850.4), '850 m');
  assert.equal(formatAltitude(9_999), '9,999 m');
  assert.equal(formatAltitude(12_345), '12.3 km');
  assert.equal(formatAltitude(20_000_000), '20,000 km');
  assert.equal(formatAltitude(Number.NaN), '—');
  assert.equal(formatZoom(10.44), '10.4');
  assert.equal(formatHeading(-10), '350°');
  assert.equal(formatHeading(359.7), '000°');
  assert.equal(formatHeading(45), '045°');
  assert.equal(formatPitch(-90), '−90°');
  assert.equal(formatPitch(-35.2), '−35°');
  assert.equal(formatPitch(0), ' 00°');
  assert.equal(formatUtc(Date.parse('2026-09-27T21:04:05.900Z')), '2026-09-27 21:04:05Z');
});

test('grid references: MGRS and UTM to the metre, truncated, fixed width; past the UTM limits it says so', () => {
  // GeographicLib's GeoConvert gives 04QFJ1841556553 and 04n 618415.97 2356553.52 for this point.
  assert.equal(formatGridReference(21.307, -157.85831, 'mgrs'), ' 4Q FJ 18415 56553');
  assert.equal(formatGridReference(21.307, -157.85831, 'utm'), ' 4Q 618415mE 2356553mN');
  assert.equal(formatGridReference(-33.8688, 151.2093, 'mgrs'), '56H LH 34368 50948');
  assert.equal(formatGridReference(-33.8688, 151.2093, 'utm'), '56H 334368mE 6250948mN');
  // The 2D map reports a longitude past 180° unwrapped: the same place.
  assert.equal(formatGridReference(-17.8, 178.6 - 360, 'mgrs'), '60K XF 69588 31217');
  assert.equal(formatGridReference(85, 0, 'mgrs'), 'beyond 84° N');
  assert.equal(formatGridReference(-81, 0, 'utm'), 'beyond 80° S');
});
