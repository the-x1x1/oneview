# Building a provider

A provider is `manifest + data policy + normalizer + fixtures + tests` (ADR-003).
It turns one upstream source into canonical `Observation`s and nothing else: no
rendering, no UI, no persistence, no raw network — everything reaches the world
through `ProviderContext`. Adding one touches `providers/<dir>/`, `fixtures/<dir>/`,
one record in `config/licenses/providers.json` and one line in the registry.

The flow below is the one used for `providers/usgs` (reference implementation),
`providers/celestrak`, `providers/firms` and `providers/weather`; run
`node --import tsx tools/provider-validator/src/cli.ts <dir>` at every step to see
which of the 16 contract checks you have left.

```
create provider → manifest → data policy (+ registry record) → normalize → fixtures → plan → provider:test → register → done
```

## 1. Create the provider package

```
providers/<dir>/
  package.json          copy from providers/usgs/package.json; name @worldview/provider-<dir>
  tsconfig.json         copy verbatim from providers/usgs/tsconfig.json
  src/manifest.ts       ProviderManifest + URL helpers
  src/normalize.ts      raw payload → ObservationDraft[]
  src/index.ts          the WorldProvider class + createProvider()
  src/*.test.ts         unit tests (node:test through tsx)
  test/contract/plan.ts + <dir>.contract.test.ts
```

`tsconfig.base.json` already maps `@worldview/provider-<dir>` to `providers/<dir>/src/index.ts`
for the planned providers; add the mapping if yours is new. The directory name and
the manifest id may differ (`providers/firms` hosts `nasa-firms`, `providers/weather`
hosts `nws-alerts`) — declare that in the plan's `aliases`.

Import only `@worldview/world-model` and `@worldview/provider-sdk`.
`node tools/dev/boundary-check.mjs` fails on `node:fs`, `node:http`, `undici`, `ws`,
React, Cesium, MapLibre, Electron, `@worldview/render-*`, `@worldview/ui`,
`@worldview/state-engine` and relative imports into other packages.

## 2. Manifest

`src/manifest.ts` exports a `ProviderManifest` (frozen shape, `packages/provider-sdk/src/manifest.ts`).
What each provider had to decide:

| Field | USGS | CelesTrak | FIRMS | NWS |
| --- | --- | --- | --- | --- |
| `id` | `usgs-earthquakes` | `celestrak` | `nasa-firms` | `nws-alerts` |
| `objectTypes` | `earthquake` | `satellite` | `fire-detection` | `weather-alert` |
| `capabilities` | live + historical (FDSN) | live | live + boundsQuery (viewport → padded area) | live |
| `credentials` | none | none | `firms.mapKey` (api-key, required, helpUrl) | none |
| `refreshPolicy.intervalMs` | 60 s (feed cadence) | 15 s propagation, catalog fetched ≤ every 2 h (etiquette) | 10 min, sources sequential (quota) | 5 min, ETag revalidation |
| `refreshPolicy.freshness` | override earthquake | override satellite (`observedAt` = element epoch) | default fire-detection | override weather-alert live 1800 s |
| `attribution.text` | courtesy | citation (required) | `NASA FIRMS` (required, on-screen) | courtesy |
| `allowedHosts` | `earthquake.usgs.gov` | `celestrak.org` | `firms.modaps.eosdis.nasa.gov` | `api.weather.gov` |

Rules the schema enforces: kebab-case ids, `intervalMs ≥ minIntervalMs`, network
transports need `allowedHosts`, `offlinePackAllowed ⇒ redistributionAllowed`,
excluded / manual-review providers cannot be `enabledByDefault`.

Put upstream etiquette in the manifest comment (fetch cadence, User-Agent, quota)
and encode it in `refreshPolicy` — the runtime rate-limits from those numbers.

## 3. Data policy and the legal registry

`manifest.dataPolicy` must equal the provider's record in
`config/licenses/providers.json` (the **Data Policy** check diffs the eight
boolean/enum flags; copy `attributionText` and `termsUrl` verbatim too). If no
record exists, add one with the conservative defaults described in
`docs/legal/DATA-SOURCE-LICENSES.md` §1 and note it there. `commercialReview` is
copied from the record; `enabledByDefault` follows `plannedStatus`
(`default` → true, `auth-required` → true but idle until the key exists,
`optional` / `deferred` / `excluded` → false).

If a record cannot satisfy the manifest schema (CelesTrak had
`offlinePackAllowed: true` with `redistributionAllowed: false`), change the record
conservatively, explain it in the record's `notes` and in the legal doc — never
loosen a flag to make a check pass.

## 4. Normalizer

`src/normalize.ts` is a pure function `(payload, options) → { observations, total, rejected }`.
Use `buildObservation(manifest, receivedAt, draft)` from the SDK so id, provenance
and attribution are filled from the manifest and cannot be mislabelled.

- **externalId** is the upstream's stable id: USGS event id, NORAD number, FIRMS
  `source:date T time:lat:lon` (a pixel at a minute), NWS alert URN. Authoritative
  namespaces (`satellite:norad`, `earthquake:usgs`, …) resolve through
  `@worldview/identity`; everything else becomes `<type>:<providerId>:<externalId>`.
- **observedAt** is when the *source* measured the thing, in UTC ISO
  (`epochToIso`, `Date.parse` for offset strings). Never invent it; clamp to
  `receivedAt` if upstream clocks run ahead. `effectiveFrom/Until` carry the source's
  validity window (TLE epoch + 7 d, alert onset/ends).
- **Reject rows with a reason** (`rejected: [{ index, reason }]`) instead of
  throwing; log a sample. Whole-body problems (not JSON, wrong shape, error page)
  return a rejection at index `-1` and the provider turns that into
  `ProviderError('MALFORMED')` after `res.invalidate()`.
- **Atomic admission**: a non-empty body that yields zero valid rows is malformed
  (`assertAtomicAdmission`). Rows skipped by *policy* (min magnitude, an alert whose
  zone outlines are not resolved yet) are not rejections for this purpose — count them
  separately, and report what would unblock them so the caller can act (NWS returns
  `zonesNeeded`, fetches those outlines and normalizes again).
- **payload** is provider-independent JSON: units in the key (`frpMw`,
  `brightnessK`, `speedMps`, `periodMinutes`), enums normalized
  (`confidence: low|nominal|high`, `severity: SeverityClass`), text truncated.
  `name`/`title` become object labels; `speedMps`/`headingDegrees` become motion.
- **quality**: `sourceQuality` is fixed per manifest; `positionAccuracyM` when the
  sensor footprint is known (VIIRS 375 m); flags for anything a lens may want to
  style (`propagated`, `low-confidence`, `update`).
- **rawPayloadHash** only when `dataPolicy.rawPayloadRetentionAllowed`
  (`buildObservation` drops it otherwise).

Third-party code may be adapted from the GEV clone when it is MIT (mark the file
"Adapted from gods-eye-view <path> (MIT)"); never copy data files marked *exclude*
in `docs/legal/ASSET-PROVENANCE.md`.

## 5. Provider class

Extend `PollingProvider` and implement `fetchOnce(request)`; the base class does
credential gating (`AUTH_REQUIRED` without a required key, no request issued),
health bookkeeping, error mapping and rolling error rate. Patterns worth copying:

- Check `request.signal.aborted` first; pass the signal to every request.
- Ask for what you need: `Accept`, `maxBytes`, `timeoutMs`, an identifying
  `User-Agent` when the upstream requires one (NWS builds it from a `contact` setting).
- Map upstream quirks to the right `ProviderErrorCode`: CelesTrak's 403 is a
  *rate-limit* signal (`RATE_LIMITED`, retry in 2 h); NWS's 403 is a missing
  User-Agent (`HTTP_4XX`, not retryable); FIRMS' plain-text "Invalid MAP_KEY" is `AUTH`.
- Do not re-serve last-good data yourself. The runtime's `HttpClient` serves stale
  bodies within `staleWhileErrorMs` (you see `res.stale`, report `cacheAgeMs`) and
  world state ages the last snapshot by policy. Provider-level caches are for
  *source* data you are asked not to refetch (CelesTrak's 2 h catalog in
  `context.cache`), never for hiding failures.
- Credentials: declare `credential: { key, as: 'query' | 'header' | 'bearer' }` on
  the request; the provider never sees the secret. Keep URL building in one module
  (FIRMS: `src/url.ts`) so a change of attachment style is one line.
- Settings: parse defensively in `parseSettings` (drop unknown enum values, clamp
  numbers), subscribe with `context.settings.onChange`.

## 6. Fixtures

`fixtures/<dir>/` holds deterministic, schema-faithful files with a `README.md`
table and the reference time **2026-09-21T08:00:00Z** (the validator's clock starts
five minutes later). Minimum set: `normal` (enough variety to spot-check ids, units
and edge cases), `empty` (valid, zero rows), `stale` (same rows 3–5 days old so the
type policy classifies them STALE/RECENT), and several `malformed` bodies (bad rows,
wrong shape, error page, empty string). Synthetic is the default; recorded payloads
go in `recorded/` and only when the data policy allows redistribution.

## 7. Contract plan and tests

`test/contract/plan.ts` wires provider, fixtures, settings, pretend credentials and
expectations with `definePlan` (`tools/provider-validator/src/plan.ts`). The
responder receives the `ProviderHttpRequest` and can answer per URL (FIRMS answers
per source). `expectations.verify` is where spot checks live: expected object ids,
unit conversions, flags, `rawPayloadHash` presence. Add
`<dir>.contract.test.ts` that runs `runProviderChecklist` and asserts 16 PASS / 0 SKIP.

Unit tests (`src/*.test.ts`) cover the normalizer's rejection paths and anything the
generic checklist cannot see: CelesTrak's cache window and stale-retry gap, FIRMS'
no-key behaviour and bounds → area, NWS' User-Agent and zone-geometry resolution
(`providers/weather/src/zones.test.ts`: URL validation, caching, per-poll budget,
failure backoff, and the rule that a partially resolved alert is skipped).
Tests that need an uninstalled library skip with a reason
(`test(name, { skip: 'satellite.js is not installed …' }, …)`).

## 8. Run the checklist

```
node --import tsx tools/provider-validator/src/cli.ts <dir>      # 16 checks, writes artifacts/verification/providers/<id>.json
node tools/dev/typecheck.mjs && node tools/dev/run-tests.mjs && node tools/dev/boundary-check.mjs
```

Commit the JSON report; it is release evidence. A provider is done when all 16
checks pass (SKIP is only acceptable where the runner skips for subscription
transports).

## 9. Register

Add the factory to `providers/registry` (`providerFactories` map + `createAllProviders()`);
workstreams that land in parallel export a partial map from their own file
(`providers/registry/src/space-fire-weather.ts`) which `index.ts` spreads. The
runtime validates the manifest again at registration and refuses excluded providers.
No renderer or UI change is needed: lenses key off `objectType`.
