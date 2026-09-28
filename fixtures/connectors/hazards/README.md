# Hazard-layer fixtures (`connectors/enabled/`, 2026-09-27)

Responses the shipped hazard and weather definitions are tested against, through their sidecars
(`connectors/enabled/*.test.json`) and `connectors/enabled/shipped.test.ts`. Recorded where the
source is a U.S. Government work and the terms allow it; invented in the published shape where it
is not, or where the service could not be read from here. Each file says which below.

The build container has no network. Recordings were read on 2026-09-27 through a fetching tool
that returns the response as text after a summarising pass, so they are the service's values as
that pass returned them, copied by hand into files — not byte-for-byte downloads.

| File | What it is |
| --- | --- |
| `nhc-forecast-cone.geojson` | **Recorded** (U.S. public domain): `…/NHC_tropical_weather_summary/MapServer/7/query?where=1=1&outFields=*&maxAllowableOffset=0.5&geometryPrecision=2&outSR=4326&f=geojson` — the four storms active that night (Fay AL, Polo and Rachel EP, Nolo CP), attributes as served. Two changes: the cone rings are the server's own generalisation at 0.5° (the definition asks for 0.01°, about a thousand points a cone), and `idp_filedate` / `idp_ingestdate` are moved back exactly five days (432,000,000 ms) so they precede the shared suite's clock (2026-09-23T20:00Z) instead of being refused as future times. `advdate` still reads as served (Sep 27–28). |
| `nhc-forecast-track.geojson` | **Recorded**, the same storms from layer 6 (Forecast Track), coordinates as served at `geometryPrecision=3`; times moved back five days as above. |
| `arcgis-empty.geojson` | An ArcGIS GeoJSON answer with no features — what both NHC layers answer when no storm is active, and WFIGS for a view without fires. Written by hand in the served shape. |
| `nifc-perimeters.geojson` | **Recorded** (U.S. public domain): four features of `WFIGS_Interagency_Perimeters_Current/FeatureServer/0`, from two queries (`where=1=1`, and `where=attr_PercentContained<50`, `resultRecordCount=2`, `maxAllowableOffset=0.1`, `f=geojson`). Kept: the fields the definition asks for plus a few more; geometry as the server generalised it (a triangle each). One is a prescribed burn (`RX`, Wolf Creek RX, Mississippi), which the definition's `where` and filter leave out. The served `properties.exceededTransferLimit` (the excerpt was a page of a larger answer) is left out, so the suite reads one page. `OBJECTID`s are renumbered 1–4. |
| `nowcoast-radar-wms130-capabilities.xml` | **Invented** in GeoServer's WMS 1.3.0 capabilities shape. nowcoast.noaa.gov refuses automated reading (robots.txt), so no capabilities were read from here. The service URL, layer (`conus_base_reflectivity_mosaic`) and style (`weather_radar_base_reflectivity`) are the ones God's Eye View (`server/providers/weather.js`) and Esri's published WMS sample use; the bounds, CRS list and the fifteen four-minute frames are made up. |
| `nowcoast-radar-wms130-capabilities-next.xml` | The same, one frame later (21:40Z added, 20:40Z dropped): what the definition sees on its next poll. |
| `nowcoast-goes-wms130-capabilities.xml` | **Invented** the same way for the satellite service, layer `goes_longwave_imagery`, style `goes-lir` (from GEV); bounds and frames made up. |
| `gdacs-events.geojson` | **Invented** in the shape of GDACS's `geteventlist/MAP` answer (field names, the `url` object, `Class` / `polygonlabel` rows, `severitydata`, dates without a zone), checked against a live answer on 2026-09-27 but containing no GDACS data: GDACS publishes no reuse licence. Countries (Exampleland, Sampleland), ids, names, places and values are made up. It holds every event type the six definitions read, a cyclone's cone polygon beside its centroid, a flood's three rows (centroid, affected, global), and a cyclone that has ended (`iscurrent: "false"`). |
| `gdacs-empty.geojson` | A FeatureCollection with no features (invented). |
