import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeReports, diagnosticScript } from './renderer-watchdog.js';

test('watchdog: says something useful even when the renderer said nothing', () => {
  // The blank window twice reported nothing at all — no crash, no console output. That case
  // needs a sentence, not an empty box.
  assert.match(describeReports([]), /nothing at all/);
});

test('watchdog: reports carry level, message and where it came from', () => {
  const text = describeReports([
    { level: 'error', message: 'Failed to load module script', source: 'worldview://app/', line: 1 },
    { level: 'warning', message: 'something milder' },
  ]);
  assert.match(text, /\[error\] Failed to load module script/);
  assert.match(text, /worldview:\/\/app\/:1/);
  assert.match(text, /\[warning\] something milder/);
});

test('watchdog: the diagnostic page cannot be injected into', () => {
  // The text includes console output, which can originate in a provider feed. This page
  // exists for the moment everything else has already gone wrong, so it sets textContent
  // and never innerHTML — and the payload is embedded as JSON, not concatenated.
  const script = diagnosticScript('</pre><img src=x onerror=alert(1)>');
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(script, /textContent/);
  assert.ok(script.includes(JSON.stringify('</pre><img src=x onerror=alert(1)>')), 'payload is JSON-encoded');
});

test('watchdog: rendering twice does not stack two panels', () => {
  assert.match(diagnosticScript('x'), /getElementById\('wv-diagnostic'\)/);
});
