import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedBuilder, toFeedItem } from './feed.js';
import { HOUR, eventFrom, iso } from './test-fixtures.js';

test('FeedBuilder: relevance, dedupe (updates replace), newest first, recorded flag', () => {
  const feed = new FeedBuilder();
  const items: string[] = [];
  feed.on('item', (i) => items.push(i.id));
  const quake = eventFrom({
    id: 'event:earthquake:usgs:a',
    type: 'earthquake',
    title: 'M5.7 earthquake — Japan',
    summary: 'Magnitude 5.7.',
    startAt: iso(-2 * HOUR),
    severity: 'SEVERE',
    objectIds: ['earthquake:usgs:a'],
    geometry: { type: 'Point', coordinates: [140, 36] },
  });
  const minor = eventFrom({
    id: 'event:earthquake:usgs:b',
    type: 'earthquake',
    startAt: iso(-HOUR),
    severity: 'MINOR',
  });
  const info = eventFrom({ id: 'event:earthquake:usgs:c', type: 'earthquake', startAt: iso(0), severity: 'INFO' });
  const status = eventFrom({
    id: 'event:source-status-change:usgs:1',
    type: 'source-status-change',
    title: 'USGS: offline',
    startAt: iso(-30 * 60_000),
    severity: 'INFO',
  });
  const recorded = eventFrom({
    id: 'event:weather-alert:demo:1',
    type: 'weather-alert',
    startAt: iso(-3 * HOUR),
    severity: 'MODERATE',
    provenance: { providerId: 'worldview', sourceName: 'demo', origin: 'recorded', receivedAt: iso(0) },
  });
  const a = feed.push(quake);
  assert.ok(a);
  assert.deepEqual(a, {
    id: quake.id,
    at: iso(-2 * HOUR),
    eventId: quake.id,
    objectId: 'earthquake:usgs:a',
    title: 'M5.7 earthquake — Japan',
    subtitle: 'Magnitude 5.7.',
    severity: 'SEVERE',
    type: 'earthquake',
    position: { latitude: 36, longitude: 140 },
  });
  assert.ok(feed.push(minor));
  assert.equal(feed.push(info), undefined, 'INFO earthquakes are not fed');
  assert.ok(feed.push(status), 'INFO source status is fed');
  assert.equal(feed.push(recorded)!.recorded, true);
  assert.equal(feed.size, 4);
  assert.deepEqual(
    feed.recent().map((i) => i.id),
    [status.id, minor.id, quake.id, recorded.id],
    'newest first',
  );
  assert.deepEqual(
    feed.recent({ limit: 2 }).map((i) => i.id),
    [status.id, minor.id],
  );
  assert.deepEqual(
    feed.recent({ minimumSeverity: 'MODERATE' }).map((i) => i.id),
    [quake.id, recorded.id],
  );
  feed.push({ ...quake, title: 'M5.9 earthquake — Japan (revised)' });
  assert.equal(feed.size, 4, 'update replaced the item');
  assert.equal(feed.recent().find((i) => i.id === quake.id)!.title, 'M5.9 earthquake — Japan (revised)');
  assert.equal(items.length, 5);
  feed.push({ ...minor, severity: 'INFO' });
  assert.equal(feed.size, 3, 'an update that drops below relevance removes the item');
  assert.equal(toFeedItem(eventFrom({ id: 'x', type: 'launch', startAt: iso(0) })).severity, 'INFO');
});

test('FeedBuilder: bounded to maxItems, dropping the oldest', () => {
  const feed = new FeedBuilder({ maxItems: 3 });
  for (let i = 0; i < 6; i++)
    feed.push(
      eventFrom({ id: `event:earthquake:usgs:${i}`, type: 'earthquake', startAt: iso(i * 60_000), severity: 'MINOR' }),
    );
  assert.equal(feed.size, 3);
  assert.deepEqual(
    feed.recent().map((i) => i.id),
    ['event:earthquake:usgs:5', 'event:earthquake:usgs:4', 'event:earthquake:usgs:3'],
  );
  const wide = new FeedBuilder({ minimumSeverity: 'INFO' });
  assert.ok(
    wide.push(eventFrom({ id: 'event:earthquake:usgs:i', type: 'earthquake', startAt: iso(0), severity: 'INFO' })),
  );
  const strict = new FeedBuilder({ minimumSeverity: 'SEVERE', infoTypes: [] });
  assert.equal(
    strict.push(
      eventFrom({
        id: 'event:source-status-change:x:1',
        type: 'source-status-change',
        startAt: iso(0),
        severity: 'INFO',
      }),
    ),
    undefined,
  );
  assert.equal(
    strict.push(
      eventFrom({ id: 'event:earthquake:usgs:m', type: 'earthquake', startAt: iso(0), severity: 'MODERATE' }),
    ),
    undefined,
  );
  assert.ok(
    strict.push(eventFrom({ id: 'event:earthquake:usgs:s', type: 'earthquake', startAt: iso(0), severity: 'SEVERE' })),
  );
});
