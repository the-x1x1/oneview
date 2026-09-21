# readsb-local fixtures

Synthetic **contract fixtures** in the shape of readsb / dump1090 `data/aircraft.json`
(`{ now: <epoch seconds>, messages, aircraft: [...] }`, field reference:
https://github.com/wiedehopf/readsb/blob/dev/README-json.md). They model a home receiver
near Honolulu; every hex code, callsign and registration is invented. Being the user's own
receiver output there are no third-party terms, but recorded captures still go in
`recorded/` (`pnpm provider:record readsb-local`).

| File | Purpose |
| --- | --- |
| aircraft.json | 9 rows: 2 airliners, 1 on ground, 1 military (`dbFlags: 1`), 1 stale position (`seen_pos: 68.4`), 1 MLAT, 1 TIS-B non-ICAO address (`~a90b12`), 1 Mode S row without position (dropped), 1 helicopter squawking 7700 → 8 observations |
| empty.json | valid envelope, zero aircraft (receiver up, nothing in range) |
| stale.json | same rows, `now` five minutes earlier (07:55:00Z) |
| malformed-rows.json | invalid hex, string latitude, missing latitude, out-of-range longitude, null row, duplicate hex → 1 row admitted |
| malformed-shape.json | valid JSON in the adsb.lol envelope (`ac`, `now` in ms) — wrong shape for a receiver |
| malformed-notjson.txt | plain-text placeholder readsb serves before its first decode |

Reference time for all fixtures: 2026-09-21T08:00:00Z (`now: 1789977600`).
