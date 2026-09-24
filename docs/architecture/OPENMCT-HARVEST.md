# Open MCT harvest

What WORLDVIEW takes from NASA's Open MCT (Apache-2.0), as a design, for the telemetry
phase — and why the code itself is not brought in.

## The problem Open MCT solved

Open MCT is a mission-control framework: many telemetry points, each a stream of
timestamped values with metadata (units, ranges, limits, enumerations), shown as plots,
tables, gauges and displays that a user composes. It separates **the domain object** (what
a thing is), **telemetry metadata** (what its values mean), **the telemetry provider**
(how history and real-time values are fetched) and **views** (how they are shown), and it
keeps time as a first-class, shared clock (`openmct.time`) so every view scrolls together.

Our sensors — a weather station, an air-quality monitor, a Meshtastic node, an rtl_433
reading — are telemetry points with a position. Today they are observations whose payload
holds the latest values; history has them, but nothing plots them.

## What to harvest (design)

| Open MCT concept                                                                                    | Our equivalent                                                                                                                                                                                  | Phase               |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Telemetry metadata (`values[]` with `key`, `name`, `units`, `format`, `hints.range/domain`, limits) | A per-object-type or per-definition **telemetry descriptor**: which payload keys are series, their units and formats; carried in the definition (`telemetry.series[]`) or the provider manifest | `telemetry`         |
| Telemetry provider (`request` for history, `subscribe` for real time)                               | History already stores observations; the descriptor tells the UI which payload keys to read as series; live values arrive as observations                                                       | `telemetry`         |
| Time conductor (fixed vs real-time, bounds, clock)                                                  | The existing timeline/replay; a plot follows it                                                                                                                                                 | `telemetry`         |
| Plot view (overlay plot, stacked plot), limits shading                                              | A "Readings" panel in the object's context: one or more series over the timeline window, with the descriptor's units and limits                                                                 | `telemetry`         |
| LAD table (latest available data)                                                                   | The context panel's current values, already there                                                                                                                                               | —                   |
| Composition (a display built from objects)                                                          | Collections, already there; a collection of sensors can show a stacked plot                                                                                                                     | `telemetry` (later) |
| Staleness / limit evaluators                                                                        | Freshness (already), plus limit thresholds from the descriptor feeding watch-zone rules                                                                                                         | later               |

## What is not taken

- The framework itself: Open MCT is a whole UI and plugin system on its own build; our
  renderer is React with the design tokens in `docs/architecture/UI.md`, and a second
  framework inside it is out of the question.
- Its persistence and its object store; world state and history are ours.
- Its real-time transports (WebSocket telemetry servers); the connector layer is ours.

## The shape of the telemetry phase

1. `telemetry.series[]` in a definition (and an optional descriptor on a bespoke sensor
   provider): `{ key, name, units, format, min?, max?, limits? }` — data, validated, capped.
2. History query for one object and one key over the timeline window (the history store
   already has the observations; this is a projection).
3. A Readings panel (context sections) that draws one series as a line, several as a
   stacked plot, honours the timeline, shows units and limits. No new charting dependency
   unless the licence audit passes it; an SVG plot of a few thousand points is enough.
4. Tests: descriptor validation, projection correctness against fixtures, a rendering test
   of the panel with a fixture series.

The phase brief is [docs/roadmap/phases/telemetry.md](../roadmap/phases/telemetry.md).
