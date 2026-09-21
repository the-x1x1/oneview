# fixtures/places — seed place index

`seed-places.geojson` is a small, hand-authored gazetteer used to seed the local
place search index (`search/index.json`) of a world pack and to prove offline search
in `test/offline` ("Honolulu", "HNL", "Oahu", "Japan", "Tokyo", "LAX").

## Provenance and licence

- Authored for WORLDVIEW on 2026-09-21 from general public knowledge: country names,
  ISO 3166-1 alpha-2 codes, capital cities, well-known cities, IATA/ICAO airport codes
  and Hawaiian place names. These are facts, not a copy of any third-party database.
  No OpenStreetMap, GeoNames, OurAirports, Natural Earth or GEV data was copied.
- Coordinates are rounded to 0.01° (about 1 km) and are approximate reference points
  (a city centre, an airport reference point, the summit or centre of a feature).
  Country `bounds` are coarse bounding boxes for framing only, not administrative
  boundaries; some exclude distant overseas territories (Spain excludes the Canary
  Islands, the United States box spans Hawaii to mainland Alaska).
- Licence: MIT, the same as the repository. Redistribution in world packs is allowed;
  the builder records this under provider id `worldview-seed-places`.

## Schema

FeatureCollection of `Point` features. Properties:

| Property | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable id: `place:country:<ISO2>`, `place:city:<slug>-<cc>`, `airport:<ICAO>`, `place:<kind>:<slug>-hi` |
| `name` | string | Display name (Hawaiian names keep the ʻokina and kahakō) |
| `altNames` | string[] | Alternate spellings and endonyms searched alongside `name` |
| `kind` | `country` \| `region` \| `city` \| `airport` \| `port` \| `feature` \| `poi` | |
| `countryCode` | string | ISO 3166-1 alpha-2 |
| `importance` | number 0..1 | Ranking boost (prominence proxy, not population) |
| `iata`, `icao` | string | Airports only |
| `municipality` | string | Airports only |
| `capital` | string | Countries only (the point is the capital) |
| `bounds` | `[west, south, east, north]` | Countries and islands only |

Contents: 53 countries (positioned at the capital), 54 cities, 30 major airports and
21 Hawaiian islands, towns and features (Honolulu, Oʻahu, Maui, Hilo, Kailua-Kona,
Pearl Harbor, Waikīkī, Haleakalā, Mauna Kea, Kīlauea, …).

The search index normalizes names (lowercase, diacritics and ʻokina stripped), so
"Oahu", "Kilauea" and "Haleakala" match without the special characters.
