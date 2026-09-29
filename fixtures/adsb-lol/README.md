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
| mil.json | INVENTED, in the published `/v2/mil` shape (`{ ac, msg, now, total, ctime, ptime }`, OpenAPI `V2Response_Model`, read 2026-09-27): 3 military aircraft with positions (a C-17, a C-130 and a helicopter of category A7) and 1 Mode S row without a position |
| trace-full.json | INVENTED, in the shape of the tar1090 trace file `https://adsb.lol/data/traces/<xx>/trace_full_<hex>.json` (readsb README-json.md "trace jsons"): `timestamp` in seconds, points `[secondsAfter, lat, lon, alt ft \| "ground" \| null, gs, track, flags, …]`; includes a ground point, a null altitude, a non-numeric latitude, a non-array row and an out-of-range latitude (the last three dropped). The `_fixture` key says so in the file itself. |
| routeset.json | INVENTED, in the shape of the routeset answer (`POST https://api.adsb.lol/api/0/routeset`; adsblol/api `provider.py` `_route`, read 2026-09-28), wrapped as `{ _fixture, answer }` because the real answer is a bare array: `TST123` Honolulu → San Francisco → London (a stop), `TST9` with a destination the database cannot describe (`ZZZZ`, code only), `TST404` unknown (`airport_codes: "unknown"`). |

Reference time for the point-query fixtures: 2026-09-21T08:00:00Z (`now: 1789977600000`); `mil.json` is 2026-09-27T08:00:00Z (`now: 1790496000000`) and `trace-full.json` starts an hour before that.
