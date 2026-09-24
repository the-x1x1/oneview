# Provider migration matrix

Every bespoke provider, classified against what the connector layer ([ADR-013](../adr/ADR-013-connector-architecture.md)) can carry today, with the evidence for each call. Written by phase [`provider-migration`](../roadmap/phases/provider-migration.md) against `develop @ e7622a3`, and re-checked on `develop @ b13df65` (the `imagery-scene` amendment, which touches no provider or connector). Nothing here changes what the app does: every bespoke provider stays registered, on or off by default as before, until the integrator retires one, provider by provider.

## What the classes mean

| Class       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MIGRATE** | On the provider's own fixtures of well-formed data, a definition on a Wave 1 connector produces the same external ids, positions, observation times and payload values as the provider's normalizer. Every remaining difference is listed: fields and flags nothing downstream reads, presentation details, settings, retention, and malformed rows the definition is more lenient with than the provider. |
| **HYBRID**  | The transport and most of the mapping can be written as a definition, but something the app relies on cannot: each missing piece is a named, reviewable addition (a transform, a mapping step, a connector option), listed under [amendment requests](#amendment-requests). Once they land, it can be re-checked as MIGRATE.                                                                               |
| **KEEP**    | The provider's core job is code: its own protocol or device, a propagator, a family of per-source parsers, coverage planning or a local-device kit. A connector would not make it simpler.                                                                                                                                                                                                                 |

**Evidence.** The parity claims — ids, positions, times, payload keys and values, and each known gap named with a test — are asserted by `connectors/examples/migrated/migration.test.ts` (test names are quoted) or by the shared suite through a definition's sidecar (`pnpm connector:test`). The KEEP reasons, and the descriptions of what a provider does that no test exercises, cite the provider's source files instead. A difference the test asserts is a _known gap_: if an amendment closes one, that assertion fails, and the row here is updated with it.

## Summary

| Provider id                 | Package                       | Transport             | Class       | Definition                                                                    |
| --------------------------- | ----------------------------- | --------------------- | ----------- | ----------------------------------------------------------------------------- |
| `usgs-earthquakes`          | `providers/usgs`              | https GeoJSON         | **MIGRATE** | `connectors/enabled/pending-review/usgs-earthquakes-feed.json`                |
| `nhc-storms`                | `providers/nhc`               | https JSON            | HYBRID      | `connectors/examples/migrated/nhc-storms-feed.json`                           |
| `nws-alerts`                | `providers/weather`           | https GeoJSON         | HYBRID      | none possible yet: every alert id is refused (A2)                             |
| `nasa-firms`                | `providers/firms`             | https CSV, path key   | HYBRID      | none possible yet: no usable id, path key broken (A1, A2, A4)                 |
| `aisstream-io`              | `providers/ais`               | wss JSON              | HYBRID      | `connectors/examples/migrated/aisstream-feed.json`                            |
| `worldview-seed-airports`   | `providers/infrastructure`    | filesystem GeoJSON    | HYBRID      | mapping tested; transport waits for phase `files`                             |
| `adsb-lol`                  | `providers/adsb-remote`       | https JSON            | KEEP        | fixed-point example: `connectors/examples/migrated/adsb-lol-fixed-point.json` |
| `celestrak`                 | `providers/celestrak`         | https GP elements     | KEEP        | —                                                                             |
| `public-cameras`            | `providers/cctv-public`       | https JSON/XML, packs | KEEP        | —                                                                             |
| `public-cameras-singapore`  | `providers/cctv-public`       | https JSON            | KEEP        | —                                                                             |
| `public-cameras-unverified` | `providers/cctv-public`       | https JSON, packs     | KEEP        | —                                                                             |
| `cameras-local`             | `providers/cameras-local`     | local process         | KEEP        | —                                                                             |
| `readsb-local`              | `providers/readsb-local`      | loopback HTTP JSON    | KEEP        | —                                                                             |
| `ais-local`                 | `providers/ais-local`         | TCP NMEA 0183         | KEEP        | —                                                                             |
| `purpleair-local`           | `providers/purpleair-local`   | LAN HTTP JSON         | KEEP        | —                                                                             |
| `weatherlink-local`         | `providers/weatherlink-local` | LAN HTTP JSON         | KEEP        | —                                                                             |

Sixteen providers: the fourteen provider packages under `providers/` (`cctv-public` registers three ids; `providers/registry` is the registry itself) — the same sixteen ids the runtime reserves against definition ids (`providerIds()`).

Against the brief's starting classification: `nhc-storms`, `nasa-firms` and `aisstream-io` were expected to migrate and do not yet; the NWS alerts "alone" do not either. The reasons are in each section.

## MIGRATE

### `usgs-earthquakes` → `usgs-earthquakes-feed`

Ready to ship beside the provider. To replace it, A8 (retention) must land first, and A6 if its two settings are to survive.

- **Transport.** One GET of `summary/all_day.geojson` a minute; the `geojson` connector with the same URL, cadence (60 s), timeout (15 s), size cap (12 MiB) and freshness (live 1 h, recent 24 h).
- **Parity.** On `fixtures/usgs/normal.geojson` and `stale.geojson` — "usgs-earthquakes: the definition matches the bespoke normalizer on …": the same eight external ids; the same `observedAt`, latitude and longitude; the same altitude (depth as `-depthKm × 1000` metres, through `scale:-1000`); the same payload keys but one, each with the same value (`magnitude`, `magType`, `depthKm`, `place`, `title`, `status`, `eventType`, `alert`, `tsunami`, `significance`, `felt`, `cdi`, `mmi`, `stations`, `gap`, `rms`, `dmin`, `network`, `updatedAt`, `detailUrl`); the same attribution and source quality. The shared suite passes 14/14 from the sidecar.
- **Known gaps** ("usgs-earthquakes known gaps: …", "… a non-numeric magnitude drops the field, not the event", "… which malformed rows each side refuses …", "… a reviewed definition still caps retention at seven days"):
  - `aliases` is not written: USGS sends `ids` as one comma-separated string and there is no `split` transform (A3). The context panel's Aliases row is then empty; nothing else reads the key.
  - The quality flags `automatic` and `event-type:<type>` are not set (a mapping cannot set flags; A4). No code outside the provider reads them.
  - The position carries no `altitudeDatum` (`msl` in the provider; A4). Earthquakes are drawn clamped to the ground (`render-core/presentation.ts`), so nothing moves on screen.
  - **Malformed rows.** The definition refuses what the provider refuses for a missing or non-point geometry, invalid coordinates, an unreadable time (`observedAt` is `required`) and a repeated id. It is more lenient with the rest: a non-numeric magnitude or depth drops the field rather than the event (`malformed-rows.geojson`: it admits `hv74012345`, which the provider refuses); a magnitude outside −5…10 is kept; a magnitude type outside USGS's list is kept; ids are checked against the mapping's grammar, not USGS's `[A-Za-z0-9._:-]{1,64}`; text is not cut to the provider's lengths. A row the provider refuses can therefore become an earthquake object, and the earthquake rule raises an event for every earthquake object (`event-engine/src/rules/earthquake.ts`). None of this happens on the provider's normal or stale fixtures. A3 `between` and A4 `values` would close most of it.
  - `detailUrl` is kept whatever its host; the provider keeps it only on `earthquake.usgs.gov` (A3 `urlOnHost`). The renderer opens only `https:` links either way (`safeHttpsUrl`).
  - The provider's two settings — feed window and minimum magnitude — have no equivalent: a definition is fixed at the default (past day, everything). Retiring the provider without A6 removes both settings.
  - **Retention.** The provider sets no retention cap, and earthquakes are kept indefinitely (`history-store/src/retention.ts`). A definition's policy always carries one — seven days unless it names a number — and cannot say "none" (A8), so its earthquakes' history is pruned after seven days, even reviewed with the policy below. The licence audit does not compare this field.
  - **Backfill.** The provider's FDSN `historical()` query has no equivalent. Nothing in the app calls it today.
- **Identity.** The authoritative earthquake rule (`packages/identity`, `earthquake.usgs`) is keyed on the provider id `usgs-earthquakes`. Under its own id the definition's earthquakes are provider-scoped objects; given the id `usgs-earthquakes`, every object id equals the bespoke provider's ("usgs-earthquakes: object identity is the same only under the bespoke provider id"). The file keeps its own id while the bespoke provider is registered, because the loader refuses a definition whose id another provider uses.
- **To retire the bespoke provider** (the integrator's call, not this phase's): after A8, in one change: remove `usgs-earthquakes` from `providers/registry`, rename the definition's id to `usgs-earthquakes` and its record's `providerId` with it, and decide about the two settings (A6). Demo mode replays `fixtures/usgs/normal.geojson` through the bespoke normalizer (`stage-resources.mjs`), which is a separate dependency on the package.

## HYBRID

### `nhc-storms`

- **Transport.** One GET of `CurrentStorms.json` every 15 minutes; `rest-json` with `itemsPath: activeStorms`. One storm is one observation — there is no cone or track in this provider, so `explode` is not needed.
- **What the definition carries** (`nhc-storms-feed.json`, suite 14/14): the storm id, position, `lastUpdate`, name, `stormId`, `classification`, `intensityKt`, `pressureMb`, `movementDirDeg`, `movementSpeedMph`, `binNumber`, `advisoryNumber`, `advisoryIssuedAt` — equal to the provider's on `fixtures/nhc/normal.json` ("nhc-storms: ids, positions, times and shared values match; …").
- **What it cannot:**
  - the storm-id check (`al|ep|cp` + six digits): the fixture's `zz012026` becomes a storm (A4: conditions with transforms);
  - `basin` (a lookup on the id's first two letters) and `classificationLabel` (a lookup on the code) — **the storm event rule reads `classificationLabel`** (`packages/event-engine/src/rules/storm.ts`), so every storm event would read "Tropical cyclone" instead of "Tropical Storm" or "Hurricane" (A3 `slice`, A4 `values`);
  - `advisoryUrl` and `graphicsUrl`, which the provider keeps only on `www.nhc.noaa.gov` (the fixture's Sample storm links to another host); left out of the example rather than shown unchecked (A3 `urlOnHost`);
  - the `15.5N` / `129.0W` fallback when the numeric position is absent, the name fallback to the upper-cased id, the per-field range checks, and `quality.complete` following the intensity.
- **Becomes MIGRATE when** A3 (`slice`, `urlOnHost`) and A4 (`values`, conditions with transforms) land.

### `nws-alerts`

- **Transport.** `https://api.weather.gov/alerts/active?status=actual&message_type=alert,update` with an identifying User-Agent — expressible with `geojson` and a static header (the provider builds the contact from a setting; A6).
- **What stops it outright:** every alert id is a URN (`urn:oid:2.49.0.1.840.0.…`) and the feature id is its URL; a mapping refuses any external id containing `:` (`packages/connector-sdk/src/mapping.ts`, `ID_VALUE`), so every record is rejected and the feed would be MALFORMED ("nws-alerts: every alert id is a URN with colons, …"). The world model and identity accept these ids; the provider emits them today (A2).
- **Even with ids:**
  - zone-only alerts need their zones' outlines fetched and joined (`zones.ts`) — not a mapping;
  - the representative point is the polygon's first vertex in a mapping and its centroid in the provider, for all seven polygon alerts in the fixture ("nws-alerts: a polygon's representative point …"; A4 `centroid`);
  - `effectiveFrom` / `effectiveUntil` cannot be mapped (A4), the one-hour expiry cut needs the clock, `severity` maps `Unknown` to `INFO` (A4 `values`), the CAP `references` list is filtered, and the flags `update` / `zone-geometry` cannot be set.
- **No definition file**: one that validates would still admit nothing.

### `nasa-firms`

- **Transport.** The area CSV API with the MAP_KEY in the path and the viewport in the path — `csv` with `credential.as: "path"`, `{TOKEN}` and `boundsQuery`. On paper.
- **What stops it:**
  - **A path credential never reaches a request.** `rest-json` builds the URL with `new URL()`, which encodes `{TOKEN}` as `%7BTOKEN%7D`; the HTTP client's `substitutePathCredential` looks for the literal placeholder and throws INTERNAL. The schema accepts such a definition and the fixture-based suite cannot see it ("nasa-firms: a path credential never reaches the request — …"; A1). This affects every `path` definition, not only FIRMS.
  - **No id.** A detection is `source:date+time:lat:lon` (`VIIRS_SNPP_NRT:2026-09-21T0742:38.99488:-121.67046`) — four columns, a padded time and colons; a mapping can neither build it (A4 `concat`, A3 `padStart`) nor accept it (A2). No single column is unique.
  - **Time.** `acq_date` and an unpadded `acq_time` (`742` = 07:42) are two columns (A4 `concat` + `timestamp:`).
  - **A bad key reads as "no fires".** The provider reads a successful response whose body is `Invalid MAP_KEY.` as AUTH (`isKeyRejection`); the `csv` connector reads it as a header row with no records and stays LIVE ("nasa-firms: … an empty, healthy catalogue to the csv connector"; A5 `requiredColumns`).
  - Confidence `l/n/h` and MODIS 0–100 map to `low/nominal/high` (A4 `values`; the MODIS ranges need a bucket step); the three default instruments are three requests per poll (three definitions, or a connector option).
- **No definition file** until A1 and A2 land.

### `aisstream-io`

- **Transport.** `wss://stream.aisstream.io/v0/stream`, a subscribe frame carrying the key and a bounding box — `websocket-json` with `{secret}` in the frame.
- **What the definition carries** (`aisstream-feed.json`, suite 10/10): MMSI, position (altitude 0; the provider's `sea-surface` datum cannot be set, A4), `time_utc` (V8's `Date.parse` reads AISStream's Go-style `2026-09-21 08:00:03.123456789 +0000 UTC`), name, `navStatus`, and the static-data fields `imo`, `callSign`, `shipType`, `destination`, `draughtM` — equal to the provider's for the full-length MMSIs, including the static-data report that wins MMSI 366123456's batch ("aisstream-io: positions, times and names match; …").
- **What it cannot:**
  - **motion.** ITU "not available" sentinels would be shown as values: `TrueHeading 511` → 151°, `COG 360` → 0°, `SOG 102.3 kn` → 52.6 m/s, where the provider drops them or falls back to the course ("aisstream-io: why motion is left out of the example — …"). The example leaves speed, course and heading out on purpose (A3 `between`; speed also needs `scale:0.514444` and `round2`, as the adsb.lol example has it, because `knotsToMps` rounds to three places first);
  - **short MMSIs** are not zero-padded (`2320001` vs `002320001`, A3 `padStart`), and so lose the authoritative vessel identity (`vessel.mmsi` needs nine digits);
  - **a rejected key** (`{"error":"Api Key Is Not Valid"}`) is AUTH in the provider and a filtered, silent message in the definition — health stays LIVE ("aisstream-io: a rejected API key is AUTH in the provider and silence in the definition"; A5);
  - the provider's **data watchdog** (a socket that opens and sends nothing is recycled after 90 s), **viewport subscription** (the view's bounds in the frame when the subscription opens, split at the antimeridian) and client-side bounds filtering (A5);
  - the navigation-status and ship-type texts (A4 `values`), rate of turn (a non-linear formula), length and beam (sums of two fields), the ETA object, `@` padding in names;
  - within one batch the newest record for an MMSI wins, so a static-data frame replaces that vessel's position report in the same batch (the fixture's six frames, one of them malformed: five observations from the provider, four from the definition). A later batch carries the vessel's next position report.

### `worldview-seed-airports`

- **Transport.** A bundled GeoJSON read through the granted resources directory — a local file, which is phase [`files`](../roadmap/phases/files.md)'s connector. No definition can name it until that lands.
- **The mapping** a `local-file` definition would carry is in the test (`AIRPORTS_MAPPING`) and reproduces all 87 airports: ids (ICAO), positions and every payload key and value ("worldview-seed-airports: the mapping reproduces all 87 airports; …"). Airports keep their authoritative identity through `payload.icao`.
- **What it cannot:** `observedAt` is the collection's `datasetDate`, which a per-record mapping cannot read (A4 root paths), and the whole-value code checks (`ICAO` exactly four upper-case characters, `IATA` three, feature type in a fixed set).
- **Becomes MIGRATE when** phase `files` ships its connector and A4's root path lands.

## KEEP

### `adsb-lol`

The provider plans coverage: one point query around the view centre (quantised so jitter does not create new endpoints), and when the view is wider than 250 nm a sweep of the commonest aircraft types worldwide, one type a poll, weighted by age and count (`coverage.ts`). `observedAt` is the snapshot's `now` minus each row's `seen_pos`. None of that is a definition.

A fixed-point query is a different, smaller product — useful for an operator's home area — and `adsb-lol-fixed-point.json` shows it (suite 14/14): ids, positions, barometric altitude in metres (its `barometric`/`ground` datum cannot be set, A4), callsign, registration, type, category, squawk, emergency, speed, heading, vertical rate, geometric altitude and the seen ages match the provider's rows ("adsb-lol fixed point: …"). It cannot carry `onGround` (`alt_baro: "ground"`), `military` (a bit of `dbFlags`), the snapshot-relative time (fetch time, flagged), the `mlat`/`tisb`/`stale-position`/`emergency:` flags, or the provider's `nonicao-` naming of TIS-B addresses. It reads headings with `number`, not `headingDegrees`, because that transform adds floating-point noise (A3; "transform defect: headingDegrees …").

### `celestrak`

Satellite positions are propagated (SGP4, `satellite-js-propagator.ts`) every 15 s from a cached element catalogue refreshed at most every 2 h 10 min; the element sets are parsed and checksummed (`elements.ts`). Propagation is code.

### `public-cameras`, `public-cameras-singapore`, `public-cameras-unverified`

`src/packs/` holds thirteen packs in twelve files (Taiwan has two) — twelve for `public-cameras`, one for `public-cameras-singapore` — and `src/unverified/` five more (Caltrans, Austin, New York City, Iowa, NZTA), each with its own normalizer. Hong Kong and Taiwan answer XML, and Trafikverket takes its key inside an XML request body (`credential.as: "xml-body"`, which a definition has no form for). Per-pack settings and licences, direction parsing, and camera media (still, MJPEG, HLS) served through the camera gateway. A definition maps records to positions; it does not fetch frames. Individual packs whose catalogue is plain JSON could become definitions for the _catalogue_ once a camera object can name its media source declaratively — not today.

### `cameras-local`, `readsb-local`, `ais-local`, `purpleair-local`, `weatherlink-local`

The local-device kit. Definitions name public https/wss hosts only (`checkUrl` refuses loopback, private and link-local addresses, directive §76); these read the operator's own devices on loopback or one trusted host under ADR-003's local-endpoint policy. `readsb-local` polls once a second, below a definition's 5 s minimum; `ais-local` decodes NMEA 0183 AIVDM sentences from a TCP stream; `cameras-local` drives streams and the go2rtc sidecar. Local connectors are phases `mqtt`, `files` and `ingest`; none of them replaces these.

## Registry records to add

For the integrator, with the review (directive §6–8). The phase does not edit `config/licenses/providers.json` (frozen).

**`usgs-earthquakes-feed`** — the source, terms and licence are those of the `usgs-earthquakes` record. To ship it:

1. Move `connectors/enabled/pending-review/usgs-earthquakes-feed.json` and its `.test.json` up to `connectors/enabled/`.
2. In the definition, set `"review": "bundled"` and open the policy the `usgs-earthquakes` record already grants (a `bundled` definition may; a `user-configured` one may not):

   ```json
   "dataPolicy": {
     "rawPayloadRetentionAllowed": true,
     "redistributionAllowed": true,
     "offlinePackAllowed": true,
     "exportAllowed": true,
     "commercialUseAllowed": true,
     "attributionRequired": false
   }
   ```

   Without it the definition stays fail-closed (commercial use unknown, no export or packs) and the record must say so instead — and retiring the bespoke provider would then take earthquakes out of exports and packs. Either way `maxRetentionSeconds` stays at seven days (A8): harmless beside the provider, whose objects are separate from the definition's, and a blocker for replacing it.

3. Add the record:

   ```json
   {
     "providerId": "usgs-earthquakes-feed",
     "name": "USGS Earthquake Hazards Program — GeoJSON summary feed (connector definition)",
     "sourceUrl": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
     "termsUrl": "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
     "license": "U.S. Government work — public domain",
     "category": "seismic",
     "plannedStatus": "optional",
     "dataPolicy": {
       "cacheAllowed": true,
       "rawPayloadRetentionAllowed": true,
       "normalizedRetentionAllowed": true,
       "redistributionAllowed": true,
       "offlinePackAllowed": true,
       "exportAllowed": true,
       "commercialUseAllowed": true,
       "attributionRequired": false,
       "attributionText": "Data courtesy of the U.S. Geological Survey",
       "termsUrl": "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits"
     },
     "commercialReview": "conditional",
     "notes": "Connector definition of the usgs-earthquakes source (phase provider-migration, docs/providers/MIGRATION-MATRIX.md). Same feed, terms and licence as that record. Off by default beside the built-in provider; takes the id usgs-earthquakes when that provider is retired."
   }
   ```

   `commercialReview` is `conditional` because `bundled` resolves to it; `commercially-reviewed` (→ `approved`, the bespoke record's level) is the alternative if the review says so.

4. `pnpm stage:resources`, then `pnpm license-audit`, `pnpm connector:test --all --dir connectors/enabled` and `pnpm test`.

These four steps were rehearsed in a throwaway worktree of this branch, with the record above parsed out of this document and `pending-review/` removed once empty: licence audit `17/17 manifests and definitions matched against 74 registry records` and `0 errors`, the suite 14/14, the definition staged to `apps/desktop/resources/data/connectors/enabled/`, `migration.test.ts` 21/21, and the runtime's loader reading the staged file as `bundled`, disabled, with export open and `maxRetentionSeconds` 604800 (A8), beside the sixteen reserved provider ids — and refusing it when its id is already taken. The output is in the phase brief.

No record is needed for the HYBRID examples: they stay in `connectors/examples/`, which is not shipped.

## Amendment requests

Each is the smallest change that would do, for the integrator to weigh. A1, A2 and A7 are defects, not features.

| #   | Where (frozen)                                                        | What                                                                                                                                                                                                                                                                                                   | Unblocks                                                                            |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| A1  | `connector-runtime/src/connectors/rest-json.ts` or `core/src/http.ts` | A `credential.as: "path"` definition throws at run time: `buildRequest` encodes `{TOKEN}` before the host substitutes it. Keep the placeholder literal (or accept `%7BTOKEN%7D` in `substitutePathCredential`), with a test through the real HTTP client.                                              | FIRMS; any key-in-path API                                                          |
| A2  | `connector-sdk/src/mapping.ts` (`ID_VALUE`)                           | Allow `:` in external ids (still no whitespace, 1–256). URNs and composite ids are refused today; the world model and identity accept them, and the bespoke providers emit them.                                                                                                                       | NWS alerts, FIRMS, URN-keyed OGC/CAP sources                                        |
| A3  | `connector-sdk/src/transforms.ts`                                     | `split:<sep>`, `padStart:<width>:<char>`, `slice:<start>:<end>`, `between:<min>:<max>` (outside → no value), `urlOnHost:<host>`; and fix `headingDegrees` (`((d % 360) + 360) % 360` turns 92.4 into 92.39999999999998).                                                                               | USGS `aliases`, AIS, NHC, FIRMS                                                     |
| A4  | `connector-sdk/src/mapping.ts`, `definition.ts`                       | A `values` lookup on a field (a literal table in the definition); `concat` (named in MAPPING.md's roadmap); `transform` on a condition; `altitudeDatum` on a position; quality flags from conditions; a `centroid` position; `effectiveFrom`/`effectiveUntil`; a root path (the body, not the record). | NHC, NWS, FIRMS, AIS, airports; USGS cosmetics                                      |
| A5  | `websocket-json.ts`, `csv.ts` connectors                              | Socket: an error-message condition → AUTH, a data-silence timeout, the viewport's bounds in the subscribe frame. CSV: `requiredColumns`, so an error body is MALFORMED rather than an empty catalogue.                                                                                                 | AIS, FIRMS                                                                          |
| A6  | `connector-sdk/src/definition.ts`, `rest-json.ts`                     | Settings a definition declares, substituted into the URL, query or headers (and read by a filter), as the viewport already is.                                                                                                                                                                         | Retiring USGS without losing its two settings; NWS contact and areas; FIRMS sources |
| A7  | `tools/dev/run-tests.mjs`, `tsconfig.json`                            | Add `connectors` to the test roots and `connectors/**/*.ts` to the type-check include. `migration.test.ts` lives where ownership puts it, and today neither `pnpm test` nor `pnpm typecheck` reaches it (tsx itself resolves its imports: it runs as is when named).                                   | This matrix's evidence in the gate                                                  |
| A8  | `connector-sdk/src/definition.ts` (`resolveDataPolicy`)               | Let a reviewed definition set no retention cap, as a manifest does by leaving `maxRetentionSeconds` out; today every definition is capped, at seven days unless it names a number.                                                                                                                     | Replacing USGS without pruning earthquake history                                   |

## Re-running the evidence

```
pnpm connector:test --all --dir connectors/enabled     # the MIGRATE definition (pending review)
pnpm connector:test --all                              # every example, including connectors/examples/migrated
node --import tsx --test connectors/examples/migrated/migration.test.ts
```

`pnpm test` does not reach the last file until A7; named directly as above, it runs (tsx resolves its `@worldview/*` imports through the root `tsconfig.json`).
