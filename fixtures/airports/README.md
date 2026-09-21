# fixtures/airports — seed airports

`seed-airports.geojson` lists 73 major international airports for the infrastructure
provider and for the `airports` layer of a world pack.

## Provenance and licence

- Hand-authored for WORLDVIEW on 2026-09-21 from public facts: IATA and ICAO codes,
  common airport names, the served municipality and ISO 3166-1 alpha-2 country codes.
  No third-party airport database (OurAirports, OpenFlights, OpenStreetMap, …) was
  copied.
- Coordinates are rounded to 0.01° (about 1 km) and approximate the airport reference
  point; they are adequate for search and map framing, not for navigation.
- Licence: MIT (repository licence). Recorded in world packs under provider id
  `worldview-seed-airports`.

## Schema

FeatureCollection of `Point` features (`[longitude, latitude]`). Properties:

| Property | Type | Notes |
| --- | --- | --- |
| `id` | string | `airport:<ICAO>` |
| `name` | string | Common name |
| `iata` | string | 3-letter IATA code |
| `icao` | string | 4-letter ICAO code |
| `type` | `'large_airport'` | Only large airports are seeded |
| `municipality` | string | City served |
| `countryCode` | string | ISO 3166-1 alpha-2 |
