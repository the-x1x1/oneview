import type { Connector, ConnectorProviderDefinition, ConnectorValidationResult } from '@worldview/connector-sdk';
import { RestJsonProvider, validateRestJson } from './rest-json.js';

/**
 * GeoJSON: a REST JSON source whose body is a FeatureCollection. The records are the
 * `features`, the position is each feature's geometry, and a feature's `id` is its external
 * id — unless the definition says otherwise. Everything else is the REST JSON connector.
 */
export const GEOJSON_CONNECTOR_ID = 'geojson';

/** The definition with GeoJSON's defaults filled in where it left them out. */
export function withGeoJsonDefaults(d: ConnectorProviderDefinition): ConnectorProviderDefinition {
  const mapping = { ...d.mapping };
  if (!mapping.externalId) mapping.externalId = { path: 'id', fallback: 'properties.id' };
  if (!mapping.position && !mapping.geometry) mapping.position = { geometry: 'geometry' };
  return {
    ...d,
    response: { ...(d.response ?? {}), itemsPath: d.response?.itemsPath ?? 'features', format: 'json' },
    mapping,
  };
}

export function validateGeoJson(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const base = validateRestJson(withGeoJsonDefaults(d));
  if (d.response?.format && d.response.format !== 'json') base.errors.push('a GeoJSON source is JSON');
  return { ...base, ok: base.errors.length === 0 };
}

export const geoJsonConnector: Connector = {
  metadata: {
    id: GEOJSON_CONNECTOR_ID,
    name: 'GeoJSON',
    description: 'Poll an HTTPS GeoJSON FeatureCollection; each feature is an object at its geometry.',
    uses: ['endpoint', 'pagination', 'response', 'mapping'],
    dataset: 'LIVE_OBJECTS',
  },
  validate: validateGeoJson,
  createProvider: (d) => new RestJsonProvider(withGeoJsonDefaults(d), 'GeoJSON'),
};
