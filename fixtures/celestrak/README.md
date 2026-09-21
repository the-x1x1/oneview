# CelesTrak fixtures

Synthetic **contract fixtures** that follow the CelesTrak GP data formats
(https://celestrak.org/NORAD/documentation/gp-data-formats.php): `FORMAT=json`
(OMM records) and `FORMAT=tle` (3-line element sets). CelesTrak data is not
redistributable (`redistributionAllowed: false` in the legal registry), so nothing
here was recorded from the live service: names and NORAD ids are real catalog
entries, every orbital value is invented but physically plausible, and TLE
checksums are computed. Record real payloads with `pnpm provider:record celestrak`
when network access exists; recorded files go in `recorded/` and must not be committed.

| File | Purpose |
| --- | --- |
| normal.json | 12 objects: ISS (25544), CSS, HST, NOAA 20, Landsat 9, a GPS satellite, GOES 16 (GEO), two Starlink, Sentinel-2A, Meteor-M 2, Aqua; epochs 1–20 h old |
| normal.tle | the same 12 objects as name/line1/line2 triples (valid checksums) |
| stale.json | the same objects with epochs 5 days old (→ STALE under the manifest's satellite policy) |
| empty.json | valid, zero records |
| malformed-rows.json | missing NORAD_CAT_ID, bad EPOCH, zero mean motion, hyperbolic eccentricity, non-numeric inclination, a non-object, one valid row and its duplicate |
| malformed-allbad.json | the invalid rows only (atomic admission → MALFORMED) |
| malformed-shape.json | valid JSON, not an array |
| malformed-notfound.txt | CelesTrak's plain-text reply for an unknown group |
| malformed-html.txt | HTML error page |
| malformed-checksum.tle | three TLE sets: one valid, one with a bad line-2 checksum, one truncated |

Reference time for all fixtures: 2026-09-21T08:00:00Z. The contract plan propagates
with the deterministic `CircularOrbitPropagator` so positions are identical on every
machine; satellite.js (SGP4) is the production propagator.
