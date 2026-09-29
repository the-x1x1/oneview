import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMapping, mapRecord } from './mapping.js';
import { TRANSFORMS, resolveTransform, transformNames, unambiguousTimestamp } from './transforms.js';

// Transforms promoted into the registry from the connectors that first needed them (the
// refactor pass, docs/roadmap/INTEGRATION.md). The connector's own tests keep covering its
// use of each; these cover the registry side: the name resolves, it is listed, and a mapping
// can name it.

test('unambiguousTimestamp: in the closed registry, listed, and nameable from a mapping', () => {
  assert.equal(TRANSFORMS['unambiguousTimestamp'], resolveTransform('unambiguousTimestamp'));
  assert.ok(transformNames().includes('unambiguousTimestamp'));
  const m = compileMapping({
    externalId: 'id',
    properties: { sent: { path: 'tst', transform: 'unambiguousTimestamp' } },
  });
  const zoned = mapRecord({ id: 'a', tst: '2026-09-23T09:59:30-10:00' }, m);
  const local = mapRecord({ id: 'b', tst: '2026-09-23 09:59:30' }, m);
  assert.ok(zoned.ok && zoned.record.properties['sent'] === '2026-09-23T19:59:30.000Z');
  assert.ok(local.ok && !('sent' in local.record.properties), 'a zone-less local time is not guessed');
});

test('unambiguousTimestamp: Unix seconds or milliseconds between 2000 and 2100, or a date-time with a zone', () => {
  const t = TRANSFORMS['unambiguousTimestamp']!;
  assert.equal(t(1790193570), '2026-09-23T19:59:30.000Z');
  assert.equal(t('1790193570.25'), '2026-09-23T19:59:30.250Z');
  assert.equal(t(1790193570123), '2026-09-23T19:59:30.123Z');
  assert.equal(t('2026-09-23T09:59:30-1000'), '2026-09-23T19:59:30.000Z');
  assert.equal(t('2026-09-23 19:59:30Z'), '2026-09-23T19:59:30.000Z');
  assert.equal(t('2026-09-23T09:59:30.5-10:00'), '2026-09-23T19:59:30.500Z');
  assert.equal(t('2026-09-23 09:59:30'), undefined);
  assert.equal(t(42), undefined, 'a counter, not a clock');
  assert.equal(t(4_200_000_000_000), undefined, 'after 2100');
  assert.equal(t(''), undefined);
  assert.equal(t(null), undefined);
  assert.equal(t(true), undefined);
  assert.equal(t('2026-02-30T09:59:30Z'), undefined, 'a date that does not exist');
  assert.equal(t('2028-02-29T00:00:00Z'), '2028-02-29T00:00:00.000Z');
  assert.equal(unambiguousTimestamp(Number.NaN), undefined);
});
