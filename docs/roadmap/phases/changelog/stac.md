### Added

- **Imagery footprints from STAC** (`stac` connector; guide in `docs/connectors/stac.md`).
  A definition pointed at a STAC API's `/search` shows where and when satellites and
  aircraft imaged the view: one object per scene at the centre of its bbox, with its
  footprint, capture time, collection, platform, cloud cover, ground sample distance,
  thumbnail link and asset list. The search is written once in its JSON form; the
  connector adds the view as `bbox` (a view across 180° is searched as two halves), a
  rolling time window (seven days unless the definition says `P30D` or similar, and
  adjustable in Sources as **Time window (days)**) and a page size, POSTs it — falling back
  to GET for servers without POST search — and follows `next` links, GET or POST with
  `body`/`merge`, on the endpoint's own origin up to `maxPages`. A definition pointed at a
  static catalogue (`catalog.json`) walks its `child` and `item` links instead, depth first,
  to a depth cap (**Catalogue depth** in Sources) and a document budget, reading each file
  once and never leaving the host. Footprints over 5,000 vertices are thinned so they cannot
  flood the map, and Source Health says when a search stopped with scenes left, a footprint
  was thinned or dropped, or a walk skipped a branch or a host. Imagery itself is not
  downloaded or drawn.
- Example definitions: Sentinel-2 L2A from Earth Search, and Capella Space's open SAR
  catalogue as a static catalogue — both user-configured and off, with the fail-closed data
  policy.

### Changed

- Until the world model has an `imagery-scene` type, scenes are `place` objects with
  `kind: imagery-scene`: they draw as place markers at their centres, their footprints are
  carried but not yet drawn, and a search for "places" finds them.
