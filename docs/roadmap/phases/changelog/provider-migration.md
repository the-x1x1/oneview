### Added

- **Which built-in sources could be definitions, with the evidence**
  (`docs/providers/MIGRATION-MATRIX.md`). All sixteen bespoke providers are classified:
  USGS earthquakes can be carried by a definition today; NHC storms, NWS alerts, NASA
  FIRMS, AISStream and the seed airports get part of the way and the matrix names exactly
  what each is missing; adsb.lol, CelesTrak, the public cameras and the local-device kit
  stay code. Nothing the app does changes: every built-in provider stays registered, on or
  off by default as before.
  Three defects in the connector layer turned up on the way and are filed as amendment
  requests there: a key in the URL path (`credential.as: "path"`) never reaches the
  request, because the REST connector percent-encodes the `{TOKEN}` placeholder first;
  external ids containing `:` (URNs, composite ids) are refused by every mapping; and the
  `headingDegrees` transform returns 92.39999999999998 for 92.4.
- A USGS earthquakes definition (`connectors/enabled/pending-review/usgs-earthquakes-feed.json`)
  that matches the built-in provider's ids, positions (depth as a negative altitude), times
  and field values on its own fixtures. It waits for review — user-configured, off, and not
  shipped — and the matrix carries the licence-registry record and the four steps to ship
  it, rehearsed. It is not yet a replacement: it lacks the provider's feed-window and
  minimum-magnitude settings and the `aliases` list, is more lenient with malformed rows,
  and cannot keep earthquake history indefinitely as the provider does.
- Examples of how far a definition gets for NHC storms, AISStream vessels and a fixed-point
  adsb.lol query (`connectors/examples/migrated/`), and a test that compares every
  definition with the built-in normalizer on the same fixtures, field by field
  (`connectors/examples/migrated/migration.test.ts`).
