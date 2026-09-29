import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSplashPhase } from './splash.js';

test('splash: lifts on the first frame or the time limit, fades, and with reduced motion simply goes', () => {
  assert.equal(nextSplashPhase('shown', 'firstFrame', false), 'fading');
  assert.equal(nextSplashPhase('shown', 'timeout', false), 'fading');
  assert.equal(nextSplashPhase('fading', 'faded', false), 'gone');
  assert.equal(nextSplashPhase('shown', 'faded', false), 'shown', 'a stray fade end does not hide it early');
  assert.equal(nextSplashPhase('shown', 'firstFrame', true), 'gone', 'no fade with reduced motion');
  assert.equal(nextSplashPhase('gone', 'firstFrame', false), 'gone', 'never comes back');
});
