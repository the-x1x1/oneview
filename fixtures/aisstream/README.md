# AISStream fixtures

Synthetic **websocket frames** in the shape AISStream.io sends after a subscription
(https://aisstream.io/documentation: `{ MessageType, MetaData, Message: { <MessageType>: … } }`).
AISStream publishes no licence and forbids redistribution by default in WORLDVIEW's policy,
so nothing here was recorded from the live stream: MMSIs, names, call signs and IMO numbers
are invented. Traffic sits in Honolulu Harbor / Mamala Bay; the contract plan subscribes with
bounds west −158.3, south 21.1, east −157.6, north 21.5.

Frames are fed in file order by `test/contract/plan.ts` (`subscription.frames`).

| Frame | Purpose |
| --- | --- |
| frames/01-position-report.json | Class A position report, `time_utc` with nanoseconds (`… +0000 UTC`), heading 252, SOG 11.4 kt, under way |
| frames/02-position-heading-511.json | `TrueHeading: 511` (not available) → heading falls back to COG 96.5 (flag `heading-from-cog`); ROT −128 dropped |
| frames/03-position-anchored.json | Short numeric MMSI (`2320001` → padded `002320001`), ISO `time_utc`, SOG 102.3 / COG 360 sentinels dropped, ROT 127 → flag `turning-right`, at anchor |
| frames/04-ship-static-data.json | ShipStaticData for the first vessel: IMO, call sign, type 70 (cargo), dimensions → length 162 m / beam 25 m, draught, ETA |
| frames/05-malformed.json | Valid JSON, unusable content (string MMSI, string latitude) → rejected, not liveness |
| frames/06-out-of-bounds.json | Valid position report in Tokyo Bay → outside the subscription bounds, dropped client-side |
| frames/07-auth-error.json | `{ "error": "Api Key Is Not Valid" }` envelope (used by unit tests, not by the contract plan) |
| frames/08-not-json.txt | Truncated frame (unit tests) |

Contract plan expectation: the checklist subscribes without viewport bounds (whole world), so
the first six frames yield 5 observations (four vessels + one static-data observation for
MMSI 366123456). Bounds filtering of frame 06 is asserted by the provider's unit tests, which
subscribe with the Honolulu bounds above.

Reference time for all fixtures: 2026-09-21T08:00:00Z.
