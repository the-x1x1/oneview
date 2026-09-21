# Seed airports

`seed-airports.geojson` is the **bundled dataset** read by `providers/infrastructure`
(`worldview-seed-airports`), not only a test fixture. It is authored in this repository
under MIT: 87 major world airports as Point features with properties
`{ id, name, iata, icao, type, municipality, countryCode }`. Content is curated public fact
(ICAO/IATA codes, names, city, country) with coordinates rounded to 0.01° — a reference
marker for lenses, not survey data. No third-party airport database (OurAirports, OSM, …)
was copied. The top-level `datasetDate` becomes every observation's `observedAt`.

Coverage: Hawaii (HNL, OGG, KOA, ITO, LIH), the large US/Canada hubs, Latin America, Europe,
Middle East, Africa, South/East/Southeast Asia, Oceania and the Pacific (GUM, NAN, PPT).

| File | Purpose |
| --- | --- |
| seed-airports.geojson | the dataset (87 features, `datasetDate` 2026-09-01) |
| empty.geojson | valid collection, zero features |
| stale.geojson | five features with `datasetDate` 2024-01-01 (older than the airport LIVE window of one year) |
| malformed-rows.geojson | out-of-range latitude, lower-case ICAO, LineString geometry, missing name, duplicate ICAO, non-object feature → 1 admitted |
| malformed-shape.json | valid JSON, not a FeatureCollection |
| malformed-notjson.txt | HTML error page |

Reference time for fixtures: 2026-09-21T08:00:00Z.
