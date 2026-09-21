# Event rules

Package: `@worldview/event-engine`. ADR-010: events are derived by deterministic rules
from objects and source health. Rules never create observations, decide identity, alter
timestamps, invent severity or merge objects. Same input → same event ids and content.

```
WorldState.onChange / ingestBatch ─► ObjectRule.evaluate(objects, ctx) ─► EventStore.upsert
                                                                         ├─► WatchZoneEvaluator ─► watch-zone-entry + notification
                                                                         └─► FeedBuilder ─► FeedItem
SourceHealthRegistry 'change' ─► SourceStatusTracker ─► EventStore
```

Event provenance: `providerId: 'worldview'`, `origin: 'derived'` — or `'recorded'` when any
input object is recorded (demo data stays labelled), `'historical'` when all inputs are
replayed, `'local'` for source status. `confidence` = class of the mean object confidence.

## earthquake (`event:earthquake:<namespace>:<value>`)

| magnitude | severity |
|---|---|
| < 3.0 | INFO |
| 3.0 – 4.49 | MINOR |
| 4.5 – 5.49 | MODERATE |
| 5.5 – 6.99 | SEVERE |
| ≥ 7.0 | EXTREME |
| unknown | INFO |

Title `M5.7 earthquake — <place>`; summary from magnitude (+ magType), depth, origin time,
status and the source's tsunami flag only; geometry = epicentre point; `startAt` = origin time.

Aftershock relation: an earthquake within **100 km** and **≤ 7 days after** a mainshock of
magnitude **≥ 5.5** that is **larger** than itself gets `properties.mainshockEventId`.
When several qualify: nearest, then larger magnitude, then smaller id. A mainshock that
arrives after its aftershocks re-links the stored ones. `EventStore.related()` follows the
link both ways.

## wildfire-cluster (`event:wildfire-cluster:worldview:<hash(first detection id)>`)

Scope: all live fire detections each run (grid-accelerated single linkage).

| rule | value |
|---|---|
| link two detections | ≤ **5 km** apart and ≤ **24 h** apart |
| identity | hash of the earliest detection id; an existing active cluster sharing any member keeps its id (earliest `startAt` wins) |
| merge | absorbed cluster gets `endAt = now`, `properties.mergedInto` |
| end | active cluster with no surviving detections gets `endAt = now` |
| severity | ≥ **50** detections or FRP sum ≥ **500 MW** → SEVERE · ≥ **10** detections → MODERATE · else MINOR |
| geometry | convex hull polygon (≥ 3 non-collinear points) or bounding box padded 0.005° |
| properties | `detectionCount`, `frpSumMw` (from `properties.frpMw` \| `frp`), `firstDetectionId`, `firstDetectionAt`, `lastDetectionAt`, `bounds`, `providers` |

## weather-alert (`event:weather-alert:<namespace>:<value>`)

Severity from `properties.severity` (CAP words Extreme/Severe/Moderate/Minor → classes,
anything else INFO; numeric 1–4 also accepted). `startAt` = `properties.effectiveFrom |
onset | effective | observedAt`; `endAt` = `object.validUntil | properties.expires | ends`.
Title = `labels.title | properties.headline | properties.event | "Weather alert"`; geometry
= alert polygon or point.

## launch (`event:launch:<namespace>:<value>`)

INFO. `startAt` = `properties.net | windowStart | launchAt | observedAt`, `endAt` =
`properties.windowEnd`; title `Launch — <name>`; summary from vehicle, provider, pad, status.

## source-status-change (`event:source-status-change:<providerId>:<compact time>`)

INFO. Emitted on transitions **into or out of** `OFFLINE`, `AUTH_REQUIRED`, `ERROR`
(DEGRADED/STALE/RATE_LIMITED/STARTING are not notable), throttled to **one event per
provider per 10 minutes**. Properties: `providerId`, `from`, `to`, `sourceName`, `message?`,
`errorCode?`. Never contains credentials (health messages are already sanitised).

## Watch zones (`event:watch-zone-entry:<zoneId>:<subjectId>@<epoch s>`)

For each enabled zone (circle | polygon | bounds; `admin` only when it carries bounds):

- **events**: type ∈ `zone.eventTypes` (empty or `*` = all), `severity ≥ minimumSeverity`,
  geometry intersects the zone (any vertex inside the zone, or a zone sample point inside
  the polygon). Entry events never re-trigger zones.
- **objects** (aircraft, vessel) when `zone.eventTypes` includes `watch-zone-entry`:
  emitted on outside → inside transitions only, severity MINOR (gated by `minimumSeverity`).
- **dedupe**: one entry per (zone, subject) per **6 h**.
- **notification** (`ipc-contract` `notification` shape): `{ id, title, body, severity, eventId, watchZoneId }`
  — `eventId` is the subject event for event hits, the entry event for object hits.

## Feed (`FeedItem`)

Relevance: `severity ≥ MINOR` by default; INFO only for `source-status-change`. One item
per event id (updates replace, an update that drops below relevance removes). Bounded to
**500** (oldest dropped). Sorted newest first by `at` (= `startAt`), id tie-break.
`recorded: true` when `provenance.origin === 'recorded'`. `position` = point or centroid.

## whatChanged({ region, time })

| field | source |
|---|---|
| `newEvents` | events with `startAt` in range whose geometry intersects the region (newest first) |
| `endedEvents` | events with `endAt` in range (same spatial test) |
| `statusChanges` | with history: objects whose `properties.status \| labels.status` differs between the snapshot at `time.start` and the state at `time.end`; without history: `source-status-change` events in range (`objectId: source:<providerId>`) |
| `countChanges` | per object type, only where before ≠ after: before = history snapshot at `time.start` (or live objects observed before `time.start` and valid then); after = live state (or the history snapshot at `time.end` when it is > 5 min in the past) |
| `newAlerts` | the `weather-alert` subset of `newEvents` |

## Thresholds at a glance

| constant | value |
|---|---|
| `AFTERSHOCK_RADIUS_M` / `AFTERSHOCK_WINDOW_MS` / `MAINSHOCK_MIN_MAGNITUDE` | 100 km / 7 d / 5.5 |
| `CLUSTER_LINK_DISTANCE_M` / `CLUSTER_LINK_WINDOW_MS` | 5 km / 24 h |
| cluster severity | 50 detections · 500 MW · 10 detections |
| `SOURCE_STATUS_THROTTLE_MS` | 10 min |
| `WATCH_ZONE_DEDUPE_MS` | 6 h |
| `FEED_MAX_ITEMS` | 500 |
| `EventStore` bound | 20 000 events |
| engine object memory (no state attached) | 7 d |
