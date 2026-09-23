# weatherlink-local fixtures

Synthetic **contract fixtures** in the shape of a Davis WeatherLink Live's local API,
`GET http://<device>/v1/current_conditions` (field reference and example response:
https://weatherlink.github.io/weatherlink-live-local-api/, read 2026-09-23). Every record
carries the documented fields in the documented order; the readings are invented — a
trade-wind afternoon near Honolulu — and so is the device id. Being the user's own station
there are no third-party terms, but recorded captures still go in `recorded/`.

| File | Purpose |
| --- | --- |
| normal.json | one ISS (txid 1), a leaf/soil record with every reading null, the barometer, the indoor sensor → 1 station (84.2 °F = 29 °C, 11.25 mph = 5.0 m/s from 71°, gust 21 mph, 29.968 inHg = 1014.8 hPa, 4 × 0.01 in = 1.0 mm today) |
| two-transmitters.json | two ISS transmitters (the second scanning, battery low, a 0.2 mm collector) and the barometer → 2 stations |
| empty.json | valid envelope, no records (a device just after start) |
| stale.json | normal.json's records two hours earlier (18:00:00Z) |
| error.json | the device's error envelope (`code` 409, the documented message) |
| malformed-rows.json | txid a string, every reading null, a null record, txid 9, a string temperature with humidity 140 → nothing admitted |
| malformed-shape.json | valid JSON in readsb's aircraft.json shape — the wrong device at the address |
| malformed-notjson.txt | an HTML error page |

Reference time for all fixtures: 2026-09-23T20:00:00Z (`ts: 1790193570` is 30 s earlier).
