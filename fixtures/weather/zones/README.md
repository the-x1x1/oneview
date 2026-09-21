# NWS zone outline fixtures

Responses from `https://api.weather.gov/zones/{type}/{id}`, the second request the NWS
provider makes: alerts that carry no polygon of their own name the zones they cover, and
this is where those outlines come from (see `providers/weather/src/zones.ts`).

| File | What it stands for |
| --- | --- |
| `COZ003.geojson` | a single-polygon forecast zone, as named by the zone-only alert in `../normal.geojson` |
| `COZ010.geojson` | a zone whose outline is a MultiPolygon (two disjoint areas) |
| `malformed.geojson` | a zone document with `geometry: null` — the alert stays skipped rather than being drawn somewhere invented |

Coordinates are simplified rectangles in the right places, not the real zone boundaries:
these fixtures exercise the parsing, combining and caching paths, and nothing in the
product treats them as data. Live zone outlines are fetched from api.weather.gov under
the same public-domain terms as the alert feed (`config/licenses/providers.json`).
