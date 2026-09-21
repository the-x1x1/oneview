# adsb.lol fixtures

Synthetic **contract fixtures** in the shape of the adsb.lol v2 point query
(`https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}` → `{ ac: [...], now, total, msg }`,
rows follow readsb's aircraft.json field names). Nothing here was recorded from the live
API: hex codes, callsigns and registrations are invented so the files carry no ODbL
obligations and tests stay deterministic. Record real payloads with
`pnpm provider:record adsb-remote` when network access exists; recorded files go in `recorded/`.

Traffic is placed around Honolulu (PHNL, 21.32 / -157.92), which is the contract plan's
`homePosition` setting.

| File | Purpose |
| --- | --- |
| normal.json | 9 rows: 2 airliners, 1 on ground (`alt_baro: "ground"`), 1 military (`dbFlags: 1`), 1 stale position (`seen_pos: 75.2` → flag `stale-position`), 1 MLAT, 1 TIS-B non-ICAO address (`~a5b5c5`), 1 Mode S row without position (dropped), 1 helicopter squawking 7700 (`emergency: general`) → 8 observations |
| empty.json | valid envelope, zero rows |
| stale.json | same rows, snapshot `now` five minutes earlier (07:55:00Z) |
| malformed-rows.json | invalid hex, non-numeric latitude, missing longitude, out-of-range latitude, non-object row, garbage optional fields (admitted without them), duplicate hex → 1 row admitted |
| malformed-shape.json | valid JSON without an `ac` array (OpenSky-shaped) |
| malformed-notjson.txt | HTML error page |

Reference time for all fixtures: 2026-09-21T08:00:00Z (`now: 1789977600000`).
