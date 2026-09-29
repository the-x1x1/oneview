# Digitraffic Marine AIS fixtures

**INVENTED** contract fixtures in the shape of Fintraffic's Digitraffic Marine AIS REST API
(`https://meri.digitraffic.fi/api/ais/v1/locations` → GeoJSON `FeatureCollection` with
`dataUpdatedTime`; `https://meri.digitraffic.fi/api/ais/v1/vessels` → array of static-data rows),
field names and units from the service's OpenAPI (https://meri.digitraffic.fi/swagger/) and the
examples on https://www.digitraffic.fi/en/marine-traffic/, both read 2026-09-28.

Nothing here was recorded: the build machine could not read the live API (its robots.txt
refuses automated readers). MMSIs, names, call signs and IMO numbers are made up; any match with
a real ship is accidental. Digitraffic's data is CC BY 4.0, so a small recorded sample may be
added later under `recorded/` with the notice "Source: Fintraffic / digitraffic.fi, license CC
4.0 BY" — record one on a machine that can reach the API before relying on these shapes.

Reference time: 2026-09-28T10:00:00Z (`timestampExternal` values are milliseconds before it).

| File                               | Purpose                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| locations.json                     | 8 features → 5 ships: a Finnish passenger ship off Helsinki (two reports, the newer wins), an Estonian cargo ship with heading 511 (→ heading from COG) and ROT −128, a Swedish ship at anchor with COG 360, a Cypriot tanker with SOG 102.3 and ROT 127 (→ `turning-right`), an aid to navigation (`99` + MID 230); one latitude 91 and one feature without an MMSI are rejected. |
| locations-stale.json               | the first four features forty minutes older (freshness STALE).                                                                                                                                                                                                                                                                                                                        |
| locations-empty.json               | valid collection, no features.                                                                                                                                                                                                                                                                                                                                                        |
| locations-malformed-rows.json      | MMSI 0, string longitude, latitude −91, a non-object, a report an hour in the future, and one usable row with garbage optional fields (admitted without them).                                                                                                                                                                                                                    |
| locations-malformed-shape.json     | valid JSON without `features`.                                                                                                                                                                                                                                                                                                                                                        |
| malformed-notjson.txt              | an HTML-ish error body.                                                                                                                                                                                                                                                                                                                                                               |
| vessels.json                       | static data for three of the ships: the REST spelling (`referencePointA`…`D`, `shipType`) for one, the MQTT spelling (`refA`…`D`, `type`) for another, a packed ETA, draught in tenths (255 = 25.5 m or more), "not available" ETA/draught/IMO on the third; one row with a non-numeric MMSI and one non-object are skipped.                                                        |
