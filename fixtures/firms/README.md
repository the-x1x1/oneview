# NASA FIRMS fixtures

Synthetic **contract fixtures** in the NASA FIRMS area-CSV schema
(https://firms.modaps.eosdis.nasa.gov/api/area/). FIRMS data is US Government /
NASA Earthdata open data, but these rows were written in-repo (not recorded) so the
tests are deterministic and no MAP_KEY is needed. The VIIRS header matches the
live NRT product (`bright_ti4 … bright_ti5,frp,daynight`, confidence `l|n|h`,
`acq_time` unpadded); the MODIS file uses `brightness`/`bright_t31` and numeric
confidence. Record real payloads with `pnpm provider:record firms` when a key and
network access exist; recorded files go in `recorded/`.

| File | Purpose |
| --- | --- |
| viirs-snpp.csv | 8 detections (Suomi NPP): California cluster, NSW (southern hemisphere), Amazon, Siberia, Portugal (daytime, previous day); l/n/h confidences |
| viirs-noaa20.csv | 6 detections (NOAA-20) over the same fires from a different pass, plus Kalimantan |
| viirs-noaa21.csv | 5 detections (NOAA-21) |
| modis.csv | 4 MODIS detections with numeric confidence 12 / 45 / 87 / 100 (unit tests) |
| empty.csv | header only — a successful, empty catalog |
| stale.csv | 4 detections acquired 3 days earlier (→ STALE under the fire-detection policy) |
| malformed-rows.csv | truncated row, latitude 95, non-numeric longitude, acq_time 2400, month 13, confidence "x", a valid row and its duplicate |
| malformed-allbad.csv | only invalid rows (atomic admission → MALFORMED) |
| malformed-html.txt | HTML error page (not CSV) |
| malformed-invalid-key.txt | FIRMS' plain-text reply for a bad key (→ AUTH, not MALFORMED) |

Reference time for all fixtures: 2026-09-21T08:00:00Z (detections between
2026-09-20 13:21 UTC and 2026-09-21 07:42 UTC).
