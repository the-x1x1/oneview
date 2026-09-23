# NHC fixtures

Contract fixtures in the shape of `https://www.nhc.noaa.gov/CurrentStorms.json`.

- `normal.json` — **Odalys** is the live file's entry of 2026-09-23 (Tropical Storm Odalys,
  advisory 12, transcribed field by field; checked against the public advisory text: 60 kt
  = 70 mph, 70° at 9 mph, 994 mb). **Sample** (`al092026`) is synthetic — a Category 3
  hurricane with a graphics link on a foreign host (dropped by the normalizer). The third
  entry has an id that is not an NHC storm id.
- `empty.json` — a quiet season: `activeStorms: []`.
- `stale.json` — both storms two days older.
- `malformed-rows.json` — nothing admissible (bad id, latitude 95, a string).
- `malformed-shape.json` — valid JSON without `activeStorms`.
- `malformed-notjson.txt` — an HTML error page.

NHC data is U.S. public domain (https://www.weather.gov/disclaimer). The contract clock for
these fixtures is 2026-09-23T04:00:00Z.
