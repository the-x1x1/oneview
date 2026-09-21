# Search grammar

Package: `@worldview/query-engine` (`parseSearch`, `searchWorld`). ADR-010: search is a
deterministic parser → `WorldQuery`. No LLM. Same text + same clock + same gazetteer →
same intents, always.

## Pipeline

```
text ─► coordinates? ──yes──► place intent (kind coordinate)          ["21.3,-157.9", DMS]
      └─no─► tokens ─► time phrases ─► identifiers ─► object types ─► thresholds
                     ─► spatial phrase (preposition + place) ─► leftover (place | free text)
                     ─► query intent (if anything structured) ─► command matches
```

Every stage consumes the tokens it recognises; what is left becomes a place lookup
(no object type) or free text (`query.text`, matched against ids/labels/external ids).

## Intents (`ParsedSearch.intents`)

| kind | payload | examples |
|---|---|---|
| `place` | `GazetteerHit` (id, name, kind, position, bounds?) | `Honolulu`, `HNL`, `PHNL`, `21.3,-157.9`, `21°18'25"N 157°51'30"W` |
| `object` | `objectHint { type, idCandidates[] }` | `ISS` → `satellite:norad:25544` · `a1b2c3` → `aircraft:icao24:a1b2c3` · `366123456` → `vessel:mmsi:…` · `norad 25544` |
| `query` | `WorldQuery` + human title | `earthquakes near Japan`, `M5+ earthquakes last 24 hours`, `UA123` |
| `command` | command id | `source health` → `open-source-health` |

Confidence: `HIGH` (structured, place resolved), `MEDIUM` (place unresolved, ambiguous
identifier, callsign), `LOW` (free text only). `notes[]` explains what was recognised
but not acted on (MGRS/UTM, unknown place, unitless threshold).

## Vocabulary

Object types (plural/singular + synonyms, multi-word first): earthquakes/quakes/seismic/tremors;
fires/wildfires/hotspots/fire detections/thermal anomalies; aircraft/planes/flights/jets/helicopters/ADS-B;
ships/vessels/boats/tankers/AIS; satellites/sats/spacecraft/starlink; alerts/warnings/watches/advisories;
cameras/webcams/CCTV; storms/hurricanes/typhoons/cyclones; weather stations/METAR; airports; ports/harbours;
buses/trains/transit; traffic; infrastructure; launches/rockets; sensors/buoys; places.
Stop words (`the`, `show me`, `all`, `live`, …) are dropped.

## Spatial phrases

| phrase | region |
|---|---|
| `near X`, `around X`, `close to X` | circle: city 100 km · island 100 km · airport/port 50 km · poi 25 km · coordinate 50 km; country/region → bounds |
| `over X`, `in X`, `at X`, `inside X` | bounds when the place has them, otherwise the circle above |
| `within N km|mi|nm|m of X` | circle of N |
| `<type> X` (no preposition) | bounds/circle only when X is an exact gazetteer name (`earthquakes Japan`) |

Place text is the longest run of tokens after the preposition that the gazetteer resolves
(score ≥ 0.7); trailing words are dropped one at a time. Unknown → `MEDIUM` query without
region + note.

Gazetteer: `Gazetteer.lookup(name, { kinds?, limit? })` → hits scored exact 1.0 · prefix 0.8 ·
word-prefix 0.7 · substring (≥ 3 chars) 0.6; codes (IATA/ICAO) exact only. `BuiltinGazetteer`
ships ~170 entries (31 countries, 16 US states/territories, ~55 cities, 19 Hawaii places, 55
airports). The runtime composes the full PlaceIndex in front of it with `CompositeGazetteer`.

## Thresholds

| phrase | filter |
|---|---|
| `M5+`, `M5`, `M6.5`, `magnitude > 4`, `mag 5` | `properties.magnitude gte/gt …` (implies earthquakes) |
| `above/over/at least/> N` with no unit in an earthquake query | `properties.magnitude gte/gt N` |
| `above 30000 ft`, `> 10000 ft`, `>10000ft`, `above 5 km` | `position.altitudeM` (ft × 0.3048, km × 1000) |
| `faster than 20 kt`, `at least 500 knots`, `over 100 mph`, `> 50 km/h` | `motion.speedMps` (kt × 0.514444, mph × 0.44704, km/h ÷ 3.6) |
| `below/under/at most/< N unit` | same fields, `lte/lt` |

A unitless threshold outside an earthquake query is consumed and reported in `notes`.

## Time phrases (relative to the injected `now`)

`last/past N minutes|hours|days|weeks|months`, `last 24h`, `last hour|day|week`, `today`,
`yesterday`, `since yesterday`, `this week` (from Monday 00:00 UTC), `this month`; a leading
`in the` / `over the` / `during the` is swallowed. Result: `query.time = { start, end }`.

## Identifiers

| pattern | result |
|---|---|
| `iss` (any case) | object `satellite:norad:25544` (+ gazetteer lookup) |
| `norad 25544`, `sat 25544`, `NORAD:48274`, `#25544` after norad/sat | object `satellite:norad:N` |
| 9 digits | object `vessel:mmsi:N` |
| 6 hex chars containing a digit | object `aircraft:icao24:<lower>` (MEDIUM with a–f, LOW if all digits) |
| `[A-Z]{2,3}\d{1,4}[A-Z]?` | query `aircraft` + `labels.callsign eq <UPPER>` — callsigns are never identity (ADR-011) |
| 3/4 upper-case letters | airport code via gazetteer (`HNL`, `PHNL`); lower-case also resolves when the code is exact |
| decimal / DMS pair | coordinate place; both orders accepted when hemisphere letters say which is which; never guesses |
| MGRS / UTM | declined with a note (no datum tables shipped) |

## Commands

`matchCommands(text, catalogue)`: every query word must prefix a title or keyword word;
score = matched title words / title words (+0.1 when the whole query prefixes the title).
Default catalogue: Go to location, Go live, Switch to 2D/3D, Open Source Health, Open
Diagnostics, Aviation/Disaster/Maritime/Space/Weather lens, Download offline pack, Manage providers.

## Ranking (`searchWorld` → `SearchResult[]`)

| result | score |
|---|---|
| object from an id hint, present in live state | 0.97 |
| object matched by a label filter (callsign) | 0.95 |
| place | 0.5 + 0.45 × gazetteer score (+ ≤ 0.05 proximity to `bias`) |
| query intent | HIGH 0.9 · MEDIUM 0.7 · LOW 0.45; title carries the live count: `Earthquakes near Japan (12)` |
| live object by label/id prefix | exact label 0.9 · label prefix 0.8 · id prefix 0.7 · word prefix 0.6 (+ bias bonus) |
| object hint not in live state | 0.75 |
| command | HIGH 0.9 · MEDIUM 0.73 · LOW 0.5 |
| event title prefix (when an event source is given) | 0.6 |

Ties break by kind (object, place, query, event, command) then id. Scores are in [0, 1]
and deterministic; the `bias` position only adds a small proximity bonus.

## Required examples (covered by `parse-search.test.ts` / `search-world.test.ts`)

`Honolulu` → place · `HNL` → airport · `ISS` → object · `UA123` → callsign filter ·
`earthquakes near Japan` → earthquake + Japan bounds · `fires near Los Angeles` → fire-detection +
100 km circle · `satellites over Hawaii` → satellite + Hawaii bounds · `ships near Oahu` → vessel +
100 km circle · `M5+ earthquakes last 24 hours` → magnitude ≥ 5 + time range · `a1b2c3` → icao24
candidate · `21.3,-157.9` → coordinates · `source health` → Open Source Health.

## What selecting a result does

| kind | outcome |
|---|---|
| `place` | fly to its position, or frame its bounds |
| `object` / `event` | select it, load its context, and fly to it |
| `query` | run it: one match is selected, several frame their own extent, none says so. The count shown is what the runtime returned |
| `command` | run the command — every id in `DEFAULT_COMMANDS` has an outcome, and `apps/desktop/src/renderer/store/commands.test.ts` fails the build if one is added without one |

`goto-location` is the exception: "fly"/"jump" with no place attached has nothing to fly
to, so it focuses the search box and asks for a place instead of appearing to work.
