# OGC fixtures (phase `ogc`)

Every file here was **recorded** from the named public service on 2026-09-24 between 02:29 and 02:44 UTC
(2026-09-23 afternoon, Hawaii time), by a browser on the operator's machine, and copied byte for byte. Two
things were changed and nothing else:

- **Trimmed**: the large capabilities documents keep a few feature types or layers; every other
  `<FeatureType>` or top-level child `<Layer>` element was cut out whole, and GeoServer's list of filter
  functions (`fes:Functions` / `ogc:Functions`, ~118 KB, read by nothing here) was cut from its two WFS
  documents. What remains is the recorded text.
- **Line endings**: the Vienna documents were served with CRLF; they are stored LF like every other
  fixture. `ogc.test.ts` parses them again with CRLF restored and gets the same result.

Variants the tests need (coordinates written latitude first, one more CRS in a list, a template on another
host, a next link off the origin) are derived from these recordings in memory inside
`packages/connector-runtime/src/connectors/ogc/ogc.test.ts` and are said to be derived there. None is
stored here.

## GeoServer — City of Vienna open data (`data.wien.gv.at`)

Terms: CC BY 4.0, "Datenquelle: Stadt Wien – data.wien.gv.at"
(https://digitales.wien.gv.at/ogd-nutzungsbedingungen/; the capabilities' own `Fees` still name CC BY 3.0 AT).

| File                                     | Request                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `geoserver-wien-wfs200-capabilities.xml` | `https://data.wien.gv.at/daten/geo?service=WFS&request=GetCapabilities&version=2.0.0` — 3 of 377 feature types kept (CITYBIKEOGD, TRINKBRUNNENOGD, WLANWIENATOGD), functions cut                                          |
| `geoserver-wien-wfs110-capabilities.xml` | same, `version=1.1.0` — 3 of 378 kept, functions cut                                                                                                                                                                     |
| `geoserver-wien-wlan-page1.json`         | `…/daten/geo?service=WFS&request=GetFeature&outputFormat=application/json&typeNames=ogdwien:WLANWIENATOGD&version=2.0.0&bbox=48.205,16.365,48.212,16.375,urn:ogc:def:crs:EPSG::4326&srsName=urn:ogc:def:crs:EPSG::4326&count=4&startIndex=0` |
| `geoserver-wien-wlan-page2.json`         | same, `startIndex=4`                                                                                                                                                                                                     |
| `geoserver-wien-wlan-page3.json`         | same, `startIndex=8` (the last two of `numberMatched` 10)                                                                                                                                                                |
| `geoserver-wien-wlan-crs84.json`         | same feature type, `bbox=16.365,48.205,16.375,48.212,urn:ogc:def:crs:OGC:1.3:CRS84&srsName=urn:ogc:def:crs:OGC:1.3:CRS84&count=4`                                                                                          |
| `geoserver-wien-wlan-empty.json`         | same, `bbox=-150.1,-10.1,-150,-10,urn:ogc:def:crs:OGC:1.3:CRS84` (the Pacific: no features)                                                                                                                                |
| `geoserver-wien-wlan-wfs110.json`        | `…&typeName=ogdwien:WLANWIENATOGD&version=1.1.0&maxFeatures=3&srsName=EPSG:4326`                                                                                                                                          |

What they show: asked for `urn:ogc:def:crs:EPSG::4326`, GeoServer's GeoJSON names that (latitude-first) CRS
in its `crs` member **and writes longitude first** (Stephansplatz at `[16.371…, 48.208…]`); the same holds
for `EPSG:4326` and for WFS 1.1.0. Asked for nothing, it answers in the national grid (EPSG:31256, not
recorded). Its WFS 2.0 JSON carries a `next` link to its backend host `stp.wien.gv.at`, which the connector
never follows. The feature type lists only `EPSG::31256` as a CRS; the service reprojects anyway.

## Vienna WMS (`data.wien.gv.at/daten/wms`, server not stated; ESRI-style capabilities)

| File                              | Request                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `vienna-wms111-capabilities.xml`  | `https://data.wien.gv.at/daten/wms?service=WMS&request=GetCapabilities&version=1.1.1` — root and 3 of 422 layers |
| `vienna-wms130-exception.xml`     | same, `version=1.3.0`: the service answered this `ServiceException` (HTTP 200)                                  |

What they show: WMS 1.1.1 `SRS` and `LatLonBoundingBox` inherited from the root layer, `ScaleHint`, a GetMap
URL advertised as plain `http://`. Terms as above.

## MapServer — MSC GeoMet, Environment and Climate Change Canada (`geo.weather.gc.ca`)

Terms: ECCC Data Servers End-use Licence, "Data Source: Environment and Climate Change Canada"
(https://eccc-msc.github.io/open-data/licence/readme_en/).

| File                                     | Request                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `mapserver-geomet-wms130-radar.xml`      | `https://geo.weather.gc.ca/geomet?service=WMS&version=1.3.0&request=GetCapabilities&layer=RADAR_1KM_RRAI` (GeoMet's own one-layer filter; untrimmed) |
| `mapserver-geomet-wms111-radar.xml`      | same, `version=1.1.1` (a DOCTYPE with an internal subset)                                                            |
| `mapserver-geomet-wms130-exception.xml`  | same, `layer=GDPS.ETA_TT`: a layer the service no longer offers, answered with a `ServiceExceptionReport`             |

What they show: three levels of named group layers inheriting CRS, bounds and `Attribution`; a `time`
dimension with a default and a `start/end/period` extent; sixteen styles with `GetLegendGraphic` URLs.

## pygeoapi — MSC GeoMet OGC API (`api.weather.gc.ca`)

Terms as for GeoMet above.

| File                                       | Request                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `pygeoapi-geomet-collection.json`          | `https://api.weather.gc.ca/collections/hydrometric-stations?f=json`                             |
| `pygeoapi-geomet-hydrometric-page1.json`   | `https://api.weather.gc.ca/collections/hydrometric-stations/items?f=json&limit=8&bbox=-123.3,49.1,-122.9,49.4` |
| `pygeoapi-geomet-hydrometric-page2.json`   | the page's `next` link as the server wrote it: `…/items?offset=8&limit=8&bbox=-123.3,49.1,-122.9,49.4` |
| `pygeoapi-geomet-hydrometric-page3.json`   | `…/items?offset=16&limit=8&bbox=…` (the last 4 of `numberMatched` 20)                            |
| `pygeoapi-geomet-hydrometric-empty.json`   | `…/items?f=json&limit=8&bbox=-155.9,18.9,-154.8,20.3` (Hawaii: no stations)                     |

What they show: `next` links that drop the request's `f=json`, `numberMatched`/`numberReturned`, and a
content type of `application/json` for GeoJSON.

## QGIS Server — Canton of Solothurn geoportal (`geo.so.ch`)

Terms: the service's own capabilities state `Fees` "none" and `AccessConstraints` "none"; kept here as a
test sample only.

| File                               | Request                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qgis-so-wms130-capabilities.xml`  | `https://geo.so.ch/api/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0` — the `somap` root and 3 of its top-level entries (two of them groups), of 570 layers |
| `qgis-so-wfs110-capabilities.xml`  | `https://geo.so.ch/api/wfs?SERVICE=WFS&REQUEST=GetCapabilities&VERSION=1.1.0` — 3 of 208 feature types                                                |
| `qgis-so-wfs110-points.json`       | `https://geo.so.ch/api/wfs?SERVICE=WFS&REQUEST=GetFeature&VERSION=1.1.0&TYPENAME=ch.so.agi.av.einzelobjekte_punkte&MAXFEATURES=3&OUTPUTFORMAT=application/json&SRSNAME=urn:ogc:def:crs:EPSG::4326` |

What they show: GeoJSON longitude first with no `crs` member and no counts, whether `SRSNAME` is
`EPSG:4326` or the URN; GetFeature lists `application/vnd.geo+json`.

## ArcGIS Server — USGS The National Map (`basemap.nationalmap.gov`)

Terms: public domain (https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits).

| File                                  | Request                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `arcgis-usgs-wms130-capabilities.xml` | `https://basemap.nationalmap.gov/arcgis/services/USGSTopo/MapServer/WMSServer?request=GetCapabilities&service=WMS` |
| `arcgis-usgs-wms111-capabilities.xml` | same, `&version=1.1.1`                                                                                     |
| `arcgis-usgs-wmts-capabilities.xml`   | `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/WMTS/1.0.0/WMTSCapabilities.xml`  |

What they show: CDATA titles, comments between `CRS` elements, a GetMap URL with `:443` in it, two Web
Mercator tile matrix sets (`default028mm`, `GoogleMapsCompatible`), RESTful templates and a KVP endpoint.

## BKG — TopPlusOpen, German Federal Agency for Cartography and Geodesy (`sgx.geodatenzentrum.de`)

Terms (from the capabilities' own `Fees`): Datenlizenz Deutschland – Namensnennung – 2.0; Quellenvermerk
"Kartendarstellung: © BKG (Jahr des letzten Datenbezugs) dl-de/by-2-0, Datenquellen:
https://sgx.geodatenzentrum.de/web_public/gdz/datenquellen/datenquellen_topplusopen.html".

| File                                   | Request                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `bkg-topplus-wmts-capabilities.xml`    | `https://sgx.geodatenzentrum.de/wmts_topplus_open/1.0.0/WMTSCapabilities.xml`             |
| `bkg-topplus-wms130-capabilities.xml`  | `https://sgx.geodatenzentrum.de/wms_topplus_open?request=GetCapabilities&service=WMS&version=1.3.0` |
| `bkg-topplus-wms111-capabilities.xml`  | same, `version=1.1.1`                                                                     |

What they show: a RESTful-only WMTS whose Web Mercator matrices are named `00`…`18`, beside a UTM set.
