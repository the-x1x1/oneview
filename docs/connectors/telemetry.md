# Telemetry: readings over time

A weather station, an air-quality sensor or a logger reports numbers, and history keeps every
observation of them. The context panel's **Readings** section plots those numbers over time,
following the timeline. A source says which of its payload keys are readings with a
**telemetry descriptor**. It is data, validated where the manifest is, and it never converts a
value. Where no source describes an object's readings, a default table does. The design is
[OPENMCT-HARVEST.md](../architecture/OPENMCT-HARVEST.md).

## The `telemetry` block

A connector definition carries it beside `mapping`, and the definition's manifest carries it
as is (`ProviderManifest.telemetry`, ADR-003/013 amendment). A bespoke provider can set the
same field on its manifest.

```json
"telemetry": {
  "series": [
    { "key": "temperatureC", "name": "Temperature", "units": "°C", "format": "celsius",
      "limits": { "warnHigh": 43, "critHigh": 46 } },
    { "key": "humidityPct", "name": "Humidity", "units": "%", "format": "percent", "min": 0, "max": 100 },
    { "key": "windSpeedMps", "name": "Wind", "units": "m/s", "format": "mps" }
  ]
}
```

| Field    | Meaning                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`    | The payload key the values are read from (`payload[key]`, a number). A key the mapping writes under `properties`. Letters, digits, `_` and `.`. |
| `name`   | The series' label (1–80 characters).                                                                                                            |
| `units`  | Display only (at most 16 characters). Absent: the format's unit.                                                                                |
| `format` | One of a fixed set (below), not a format string.                                                                                                |
| `min`    | The chart's fixed lower end; absent → fitted to the data.                                                                                       |
| `max`    | The chart's fixed upper end; absent → fitted to the data. `max` ≤ `min` is refused.                                                             |
| `limits` | `warnLow`, `warnHigh`, `critLow`, `critHigh`, any of them, in the order `critLow ≤ warnLow ≤ warnHigh ≤ critHigh`. Shaded on the chart.         |

At most 32 series, and no key twice. Keep payload values SI (°C, m/s, hPa, µg/m³): the
mapping's transforms convert (`kmhToMps`, `paToHpa`, `fahrenheitToCelsius`, …); the
descriptor only labels.

| Format                             | Shown as                          |
| ---------------------------------- | --------------------------------- |
| `number:0`, `number:1`, `number:2` | that many decimals, `units` after |
| `percent`                          | `63 %`                            |
| `celsius`                          | `21.4 °C`                         |
| `hpa`                              | `1,013.2 hPa`                     |
| `mps`                              | `4.1 m/s`                         |
| `kmh`                              | `15 km/h`                         |
| `degrees`                          | `250°`                            |
| `ugm3`                             | `12.1 µg/m³`                      |
| `ppm`                              | `512 ppm`                         |
| `volts`                            | `3.71 V`                          |
| `dbm`                              | `-67 dBm`                         |

Limits are drawn, and the value at the cursor says when it is past one. Nothing alerts on
them: an alert is a watch-zone rule, not a descriptor.

## Which readings an object shows

1. **Its sources' descriptors**: every series whose key the object's current payload
   carries as a number, in its sources' order, one series per key.
2. **Its type's default**, when no descriptor applies:

   | Type              | Default readings (first key present in each group)                                                   |
   | ----------------- | ---------------------------------------------------------------------------------------------------- |
   | `weather-station` | `temperatureC`; `humidityPct`; `pressureSeaLevelHpa` or `pressureHpa`; `windSpeedMps`; `windGustMps` |

3. **Every numeric payload key**, for a `sensor` (and a weather station whose defaults all
   missed, such as a rain gauge): known keys are named and given units (`pm25Ugm3` → PM2.5,
   µg/m³; `aqiUs` → AQI with its 100/150 category edges as limits; the table is
   `KNOWN_READINGS` in `packages/telemetry/src/known.ts`); any other key is shown under its
   own name. Coordinates and elevations, identifiers (`id`, keys ending in `Id`, `ID`,
   `_id`, `_index`) and times (`timestamp`, keys ending in `Ms`, `At`) are not readings.

The section is registered for `weather-station` and `sensor` objects. Other types (a
tracker's battery, a reading pushed through ingest) need their source's descriptor and the
panel's access to manifests: the phase brief's amendment request R2.

## How the values are read

`readings(query, target, keys, window)` in `@worldview/telemetry` reads the existing
`history.query` request: the window is cut into 60 slices (one a minute for an hour) and
each slice asks for the objects known at its end, with the slice as look-back, limited to
the object's type and its providers (and, for a weather station, which does not move, to a
250 m circle around it). Each slice gives the object's latest observation in it, so a
series has at most one reading per slice. Two readings in one slice come back as the later
one: a short spike between two slice ends can be missed. A request that returns every
observation of one object is amendment request R3.

The window ends at the timeline's cursor and nothing after the cursor is read. Slices older
than a minute are kept, so a window that moves on by a slice reads one or two slices, not
sixty; while the cursor is being dragged, the last read stays on screen. The line is broken
where readings are more than three times their usual spacing apart (a reading or two missed
is bridged). While live, the object's own current values are added as it keeps reporting;
in replay they are not. The section draws at most 2,000 points per series (min/max
buckets).

## Examples

`connectors/examples/telemetry/`, `user-configured` and disabled like every example:

- `nws-station-observations.json`: the latest observation of one National Weather Service
  station (KPHX) through the `geojson` connector, km/h and Pa converted to SI, a descriptor
  with illustrative temperature limits.
- `csv-greenhouse-latest.json`: a logger's CSV of each sensor's latest readings in the
  granted folder (`local-file`), soil moisture and battery limits.

A source that returns a backlog (the last twelve observations, an append-only log) does not
fill history with it: a batch keeps one observation per object, the first one listed
(amendment request R4). Poll the latest value instead, and history builds the series.
