# Aviation reference tables

`aviation-reference.json` is a **bundled dataset**, not only a test fixture: it is staged into
the package as `resources/data/aviation-reference.json` (`tools/dev/stage-resources.mjs`) and
read by the runtime to name a selected flight's airline from its callsign and its aircraft
type from its ICAO type designator (`packages/runtime/src/support/flight-info.ts`).

| Table | Rows | From |
| --- | --- | --- |
| `airlines` — `[icao, name, iata?]` | 5,904 | `airlines/schema-01/airlines.csv`, every row with a three-letter ICAO designator |
| `types` — `[designator, name]` | 2,855 | `model-type/schema-01/*.csv`, one name per designator (the rule is in the build script's header) |

Source: Virtual Radar Server standing data, https://github.com/vradarserver/standing-data,
**CC0 1.0 Universal** (the repository's LICENSE). The commit it was built from is in the file's
`provenance` block. Nothing about individual aircraft (registrations, owners, operators) is
taken: the `aircraft/` tables are not read.

Rebuild from a checkout (a sparse one of `airlines` and `model-type` is enough):

    git clone --depth 1 --filter=blob:none --sparse https://github.com/vradarserver/standing-data sd
    git -C sd sparse-checkout set airlines model-type
    node tools/dev/aviation-reference/build.mjs sd
    node tools/dev/stage-resources.mjs
