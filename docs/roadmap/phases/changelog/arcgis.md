### Added

- **ArcGIS layers as sources** (`arcgis-feature`, phase `arcgis`). One definition reads one
  FeatureServer or MapServer layer — the way most US and Canadian cities, counties, states,
  utilities and agencies publish live data. Name the layer and, if you like, a `where`
  clause and the fields you want; the connector reads the layer's description first (page
  size, formats, field types, whether it can page), asks for GeoJSON or, from servers older
  than 10.4 or without geoJSON, esriJSON, which it converts — points, lines, polygons with
  their holes and parts in the right order — so the same definition works against either.
  Date fields arrive as ISO 8601 in both. It pages with `resultOffset` while the server says
  `exceededTransferLimit`, stops on a short or repeated page, and says in Source Health when
  a layer holds more than it read. A page too large for the download limit (heavy polygons
  over a wide view) is asked for again in smaller pages, and the smaller size is kept. With `boundsQuery` the viewport becomes the query's
  envelope, split in two across the antimeridian. A token is a credential the app attaches,
  never a value in the file. ArcGIS's "HTTP 200 with an error inside" is reported for what
  it is: an expired or missing token as AUTH, anything else with the server's own message.
  The layer check logs fields the definition names that the layer lacks, dates read with
  the wrong transform, and the layer's copyright text when the attribution leaves it out.
  Three examples (NIFC wildfire incidents and perimeters, NOAA NWS watches and warnings from
  a MapServer layer), disabled, with fixtures and a guide
  ([docs/connectors/arcgis.md](docs/connectors/arcgis.md)).
