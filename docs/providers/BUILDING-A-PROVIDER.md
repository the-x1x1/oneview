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

## 0. Or scaffold it

For a source that publishes a GeoJSON FeatureCollection of points over https — the
commonest open-data shape — `pnpm provider:scaffold` writes steps 1–7 for you:

```
pnpm provider:scaffold example-sensors --name "Example City sensors" --type sensor \
  --url https://data.example.org/sensors.geojson --licence "CC BY 4.0" \
  --attribution "Sensors: Example City open data" --id-property sensor_id --time-property updated
```

It writes `providers/<id>/` (manifest, normalizer, provider class, contract plan and
test), synthetic `fixtures/<id>/` generated to match, and appends a record to
`config/licenses/providers.json`. The 16-check contract run passes as generated
(Stale Detection is skipped when there is no `--time-property`, because the feed then
has no time of its own). `--dry-run` lists what would be written; nothing is ever
overwritten — an existing directory or record stops the run first.

What it does **not** decide is the licence. The record and the manifest it writes are
the most conservative there are — `manual-review-required`, off by default, no raw
payloads, no redistribution, no export, no offline packs, commercial use unknown —
whatever `--licence` says, because the licence text is recorded, not interpreted
(directive §6–8). A person reads the source's terms and changes both together; the
checklist and `pnpm license-audit` fail if they differ. The provider is not
registered either: that is the last step below, taken once the record is settled.

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

| Field                      | USGS                     | CelesTrak                                                 | FIRMS                                       | NWS                                |
| -------------------------- | ------------------------ | --------------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| `id`                       | `usgs-earthquakes`       | `celestrak`                                               | `nasa-firms`                                | `nws-alerts`                       |
| `objectTypes`              | `earthquake`             | `satellite`                                               | `fire-detection`                            | `weather-alert`                    |
| `capabilities`             | live + historical (FDSN) | live                                                      | live + boundsQuery (viewport → padded area) | live                               |
| `credentials`              | none                     | none                                                      | `firms.mapKey` (api-key, required, helpUrl) | none                               |
| `refreshPolicy.intervalMs` | 60 s (feed cadence)      | 15 s propagation, catalog fetched ≤ every 2 h (etiquette) | 10 min, sources sequential (quota)          | 5 min, ETag revalidation           |
| `refreshPolicy.freshness`  | override earthquake      | override satellite (`observedAt` = element epoch)         | default fire-detection                      | override weather-alert live 1800 s |
| `attribution.text`         | courtesy                 | citation (required)                                       | `NASA FIRMS` (required, on-screen)          | courtesy                           |
| `allowedHosts`             | `earthquake.usgs.gov`    | `celestrak.org`                                           | `firms.modaps.eosdis.nasa.gov`              | `api.weather.gov`                  |

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
- **observedAt** is when the _source_ measured the thing, in UTC ISO
  (`epochToIso`, `Date.parse` for offset strings). Never invent it; clamp to
  `receivedAt` if upstream clocks run ahead. `effectiveFrom/Until` carry the source's
  validity window (TLE epoch + 7 d, alert onset/ends).
- **Reject rows with a reason** (`rejected: [{ index, reason }]`) instead of
  throwing; log a sample. Whole-body problems (not JSON, wrong shape, error page)
  return a rejection at index `-1` and the provider turns that into
  `ProviderError('MALFORMED')` after `res.invalidate()`.
- **Atomic admission**: a non-empty body that yields zero valid rows is malformed
  (`assertAtomicAdmission`). Rows skipped by _policy_ (min magnitude, an alert whose
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
"Adapted from gods-eye-view <path> (MIT)"); never copy data files marked _exclude_
in `docs/legal/ASSET-PROVENANCE.md`.

## 5. Provider class

Extend `PollingProvider` and implement `fetchOnce(request)`; the base class does
credential gating (`AUTH_REQUIRED` without a required key, no request issued),
health bookkeeping, error mapping and rolling error rate. Patterns worth copying:

- Check `request.signal.aborted` first; pass the signal to every request.
- Ask for what you need: `Accept`, `maxBytes`, `timeoutMs`, an identifying
  `User-Agent` when the upstream requires one (NWS builds it from a `contact` setting).
- Map upstream quirks to the right `ProviderErrorCode`: CelesTrak's 403 is a
  _rate-limit_ signal (`RATE_LIMITED`, retry in 2 h); NWS's 403 is a missing
  User-Agent (`HTTP_4XX`, not retryable); FIRMS' plain-text "Invalid MAP_KEY" is `AUTH`.
- Do not re-serve last-good data yourself. The runtime's `HttpClient` serves stale
  bodies within `staleWhileErrorMs` (you see `res.stale`, report `cacheAgeMs`) and
  world state ages the last snapshot by policy. Provider-level caches are for
  _source_ data you are asked not to refetch (CelesTrak's 2 h catalog in
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

## Declaring settings

A provider that reads user settings declares them in its manifest (`settings[]`), and the
source panel renders that declaration — no interface change is needed to expose a new
option. The declaration describes what the provider accepts; `parseSettings` in the
provider remains the validator, and a value it will not accept is ignored in favour of
its default rather than breaking the poll.

```ts
settings: [
  {
    key: 'feed',
    label: 'Feed window',
    kind: 'enum',
    defaultLabel: 'Past day',
    options: [
      { value: 'hour', label: 'Past hour' },
      { value: 'day', label: 'Past day' },
    ],
  },
  { key: 'minMagnitude', label: 'Minimum magnitude', kind: 'number', min: -5, max: 10, step: 0.1 },
];
```

Kinds: `string`, `number`, `boolean`, `enum`, `multi-enum`. A dotted key (`packs.nsw`)
writes into a nested object. Credentials are never settings — they go through
`credentials` in the manifest and `credentials.set`, which the interface can probe but
never read. `providers/registry/src/settings.test.ts` checks that every declared key is
one the provider's source actually reads, that enum options are readable and unique, and
that no declaration looks like a secret.

## Local sources (receivers, weather stations, sensors)

A device on the user's own machine or network is a provider like any other — manifest,
data policy, normalizer, fixtures, the same 16-check checklist — with three differences
(ADR-003):

- **Transport.** `local-process` for a program on the same machine (readsb), `hardware`
  for a device (a weather station, a sensor gateway). Both count as local: they keep
  working with the network marked offline and show as "local" in Sources. Only
  `local-process` sources feed the local-aircraft capability, so a weather station is
  `hardware`.
- **Hosts.** `allowedHosts` holds loopback at most. A device elsewhere on the LAN is reached
  only through `trustedHostSetting`: the key of a `string` setting in which the user names
  one host, which the runtime adds — exactly, over plain HTTP — to that provider's
  allowlist and probe. Nothing is discovered, even when the device announces itself.
- **Detection.** The SDK's local-sensor kit does the rest the same way everywhere:

```ts
import { LocalDeviceDetector, resolveLocalEndpoint, stringSetting } from '@worldview/provider-sdk';

const host = stringSetting(raw, 'host', { host: true });
const endpoint = resolveLocalEndpoint(`http://${host}/v1/current_conditions`, {
  label: 'WeatherLink Live address',
  trustedHostSetting: 'host',
  trustedHost: host,
}); // loopback, or exactly the named host; never credentials in the URL
const detector = new LocalDeviceDetector({ what: 'WeatherLink Live', backoffMs: 60_000 });

// in fetchOnce: probe before the first poll (OFFLINE "… not detected at …" with a back-off),
await detector.ensure(this.context.local, endpoint.url, this.context.clock.now(), timeoutMs);
// … and after a transport failure, probe again next time.
try {
  res = await this.context.http.request({ url: endpoint.url, signal });
} catch (err) {
  detector.noteFailure(err);
  throw err;
}
```

A device that cannot tell where it is (a weather station) takes its position as `number`
settings and reports "Set …" until they are filled. The readings are the user's own: the
data policy allows everything and `commercialReview` is `approved`, but a local source is
off by default unless it is inert without configuration, and it never uploads anything.
Worked examples: `providers/readsb-local`, `providers/weatherlink-local`,
`providers/purpleair-local` (a device that reports its own position, overridable).
