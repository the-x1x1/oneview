import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePerfLine, describeReports, diagnosticScript } from './renderer-watchdog.js';

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

test('watchdog: a renderer [perf] line becomes structured fields, and nothing else does', () => {
  // The map's frame rate cannot be seen from outside — screenshots do not capture the canvas —
  // so the renderer reports it and the log keeps it. Only flat, short, numeric or string
  // fields get through: this is renderer output going into a file an operator may share.
  assert.deepEqual(parsePerfLine('[perf] {"fpsAvg":58,"band":"global","presentMaxMs":3.5}'), {
    fpsAvg: 58,
    band: 'global',
    presentMaxMs: 3.5,
  });
  assert.equal(parsePerfLine('an ordinary log line'), undefined);
  assert.equal(parsePerfLine('[perf] not json'), undefined);
  assert.equal(parsePerfLine('[perf] [1,2,3]'), undefined);
  assert.deepEqual(
    parsePerfLine(`[perf] {"ok":1,"nested":{"a":1},"long":"${'x'.repeat(100)}","bad key":2,"nan":null}`),
    { ok: 1 },
    'nested, long, oddly named and non-finite values are dropped',
  );
});
