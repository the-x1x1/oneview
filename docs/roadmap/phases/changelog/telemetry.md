### Added

- **Readings: a sensor's values over time** (`@worldview/telemetry`, the context panel's
  Readings section; guide in `docs/connectors/telemetry.md`; shown in the app once the
  section's import lands, the phase's amendment request R1). Selecting a weather station
  or a sensor plots its readings — temperature, humidity, pressure and wind for a
  station; every number a sensor reports, with PM2.5, AQI and the other known keys named
  and given units — one chart per reading on a shared time axis over the last 1 h, 6 h,
  24 h or 7 d. The window ends at the timeline's cursor, so replay moves it and nothing
  after the cursor is shown; pointing at a chart reads every value at that moment, and a
  click, Enter or Space puts the replay cursor there. Limits are shaded (the AQI's 100 and
  150 category edges by default) and the value at the cursor says when it is past one;
  nothing alerts on them. A connector definition names its readings, units, formats and
  limits in a `telemetry` block, validated with the manifest, and those win over the
  defaults. Values come from history through the existing `history.query` request, at
  most one per sixtieth of the window (the last in each), with long gaps shown as breaks
  and at most 2,000 points a series; an empty window says "No readings in this window".
  Two examples, disabled: the latest observation of an NWS station (KPHX) and a
  greenhouse logger's CSV.
