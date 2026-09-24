# The mapping

A mapping turns one record of a source into one observation. It is data: paths into the
record, transforms from a fixed registry, literals, fallbacks, defaults and filter
conditions. Nothing in a mapping is executed — there is no expression language, no
templates, no user code — so a definition can be reviewed by reading it, and a malicious
one can at worst map the wrong field ([ADR-013](../adr/ADR-013-connector-architecture.md)).

```json
"mapping": {
  "externalId": "station_id",
  "observedAt": { "path": "last_reported", "transform": "unixSeconds" },
  "position": { "lat": "lat", "lon": "lon" },
  "labels": { "name": "name" },
  "properties": {
    "kind": { "literal": "bike-share-station" },
    "capacity": { "path": "capacity", "transform": "integer" },
    "bikes": { "path": "num_bikes_available", "fallback": "bikes", "default": 0 }
  },
  "motion": { "speedMps": { "path": "speed_knots", "transform": "knotsToMps" }, "headingDegrees": "course" },
  "filter": [{ "path": "status", "in": ["active", "ok"] }]
}
```

## Fields

A field is a path string, or an object:

| Key         | Meaning                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `path`      | Where the value is (grammar below).                                                                    |
| `fallback`  | One path or a list tried in order when `path` reads nothing.                                           |
| `literal`   | A constant instead of a path.                                                                          |
| `transform` | One transform name or a list applied in order; a transform that yields nothing makes the field absent. |
| `default`   | Used when the paths read nothing (before transforms are considered done).                              |
| `required`  | The record is rejected when the field is absent (default: the field is simply left out).               |

At most 128 labels and properties per mapping. Label and property keys are
`[a-zA-Z][a-zA-Z0-9_-]{0,63}`.

## Paths

```
properties.mag              keys separated by dots
geometry.coordinates[1]     an array index; [-1] is the last element
["a.b"].c                   a key containing a dot or bracket, quoted
$                           the record itself
```

That is the whole grammar: no wildcards, no filters, no expressions. A path names one value
or nothing; reading it can neither run code nor reach outside the record. Paths are at most
256 characters and 32 segments deep.

## The record's parts

| Part         | Required | Meaning                                                                                                                                                                                                                                                                               |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `externalId` | yes      | The source's stable id for the object. Records without one are rejected (counted, logged with a sample of reasons, shown in Source Health).                                                                                                                                           |
| `observedAt` | no       | When the record was observed. Absent or unreadable: the fetch time, and the observation carries the `fetch-time` quality flag. More than ten minutes in the future: rejected.                                                                                                         |
| `position`   | one of   | `{ lat, lon, alt? }`, `{ geometry }` (a GeoJSON geometry: a Point's coordinates or the first coordinate of anything else), `{ lonLat }` or `{ latLon }` (a pair). A third coordinate is the altitude in metres unless `altitude: false`. Records with no valid position are rejected. |
| `geometry`   | no       | A GeoJSON geometry for line and area objects (checked: one of the six types, finite numbers).                                                                                                                                                                                         |
| `labels`     | no       | Human-readable strings (`name`, `callsign`, …); they land in the payload with the properties.                                                                                                                                                                                         |
| `properties` | no       | The payload: the per-type conventions in `docs/architecture/EVENT-RULES.md` and the world model name the keys the rest of the app reads (`magnitude`, `speedMps`, `headingDegrees`, `altitudeM`, …).                                                                                  |
| `motion`     | no       | `speedMps`, `headingDegrees`, `verticalSpeedMps` in SI: the properties the state engine and dead reckoning read.                                                                                                                                                                      |
| `filter`     | no       | Conditions a record must all satisfy to be mapped; a record that fails one is skipped (counted as filtered, not rejected).                                                                                                                                                            |

## Conditions

```json
{ "path": "type", "equals": "positions" }
{ "path": "status", "notEquals": "retired" }
{ "path": "category", "in": ["fire", "smoke"] }
{ "path": "lat", "exists": true }
{ "path": "confidence", "min": 50, "max": 100 }
```

The same conditions serve `mapping.filter` (per record) and `websocket.filter` (per message).

## Transforms

| Transform                                                                         | Does                                                                                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `number`, `integer`, `string`, `boolean`, `json`                                  | Type coercions; `boolean` reads `true/false/yes/no/1/0`; a failed `number` yields nothing             |
| `trim`, `lowercase`, `uppercase`, `emptyToNone`                                   | Strings                                                                                               |
| `first`, `last`, `length`                                                         | Arrays (and `length` of strings)                                                                      |
| `isoTimestamp`, `unixSeconds`, `unixMillis`, `timestamp:<pattern>`                | Times → ISO 8601 UTC. The pattern takes `YYYY MM DD HH mm ss`; UTC unless the value carries an offset |
| `abs`, `negate`, `round`, `round1`, `round2`, `scale:<factor>`, `offset:<amount>` | Arithmetic on one number                                                                              |
| `fahrenheitToCelsius`, `celsiusToFahrenheit`, `kelvinToCelsius`                   | Temperature                                                                                           |
| `knotsToMps`, `mphToMps`, `kmhToMps`, `feetPerMinuteToMps`                        | Speed → m/s                                                                                           |
| `feetToMeters`, `milesToMeters`, `nauticalMilesToMeters`, `kilometersToMeters`    | Length → m                                                                                            |
| `inchesHgToHpa`, `paToHpa`, `inchesToMm`                                          | Pressure, precipitation                                                                               |
| `headingDegrees`                                                                  | Normalise to 0–360                                                                                    |

The registry is closed. A source that needs a conversion the table lacks gets it added to
`packages/connector-sdk/src/transforms.ts` with a test — the transform then serves every
definition — rather than a definition-level expression. Things a mapping cannot do on
purpose: arithmetic between two fields, string concatenation, conditional values, one
record → many observations. Those are on the roadmap as named, reviewed steps (`explode`,
`concat`), not as an expression language.

## What happens to a record

1. `filter` — a failing record is skipped (filtered).
2. `externalId` — missing or empty: rejected.
3. `observedAt` — missing: fetch time, flagged; future: rejected.
4. `position` — missing or out of range: rejected. (`geometry` alone is not a position.)
5. `labels`, `properties`, `motion` — absent fields are left out; `required: true` rejects.
6. Duplicate `externalId` within one fetch: the first wins.
7. The observation is built with the definition's attribution, source quality and data
   policy, and admitted through the same schema check as a bespoke provider's.

A fetch in which every record was rejected is reported as MALFORMED (the mapping does not
fit the feed), the cached body is invalidated, and Source Health shows the reason. A fetch
with some rejections is served, and Source Health's message counts them.
