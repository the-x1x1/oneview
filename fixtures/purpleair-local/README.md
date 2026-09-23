# purpleair-local fixtures

Synthetic **contract fixtures** in the shape of a PurpleAir sensor's local JSON,
`GET http://<sensor>/json` (two-minute averages; field reference:
https://community.purpleair.com/t/sensor-json-documentation/6917, read 2026-09-23 —
firmware 7.04). The fields are the documented ones; every value, the MAC address and the
network name are invented (a clear afternoon near Honolulu). `DateTime` is written as the
firmware writes it (`2026/09/23T19:58:10z`); the normalizer also accepts ISO 8601.

| File | Purpose |
| --- | --- |
| normal.json | an outdoor dual-laser sensor: PM2.5 ATM 4.6 / 5.12 µg/m³ → 4.9, AQI 19 / 21 → 20, 88 °F → 31.1 °C (uncorrected), 1012.4 hPa |
| empty.json | the same sensor with no particulate fields yet (just started): up, nothing to show |
| stale.json | normal.json two hours earlier (18:00:00Z) |
| disagree.json | channel A 62.4, B 8.9 µg/m³ — past 5 µg/m³ and 70 % apart: flagged `channels-disagree` |
| indoor.json | `place: inside`, position 0,0 (none): CF=1 is used, and the position must come from settings |
| malformed-rows.json | SensorId not a MAC address, PM2.5 as a string |
| malformed-shape.json | valid JSON of a different device (a WeatherLink Live) at the address |
| malformed-notjson.txt | an HTML page |

Reference time for all fixtures: 2026-09-23T20:00:00Z.
