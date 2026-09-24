import type { Connector, ConnectorProviderDefinition, ConnectorValidationResult } from '@worldview/connector-sdk';
import { RestJsonProvider, validateRestJson } from './rest-json.js';

/**
 * CSV: a REST source whose body is a delimited text file with a header row (or the columns
 * the definition names). Each row is a record keyed by column; cells are strings, so the
 * mapping's `number` and timestamp transforms do the typing.
 */
export const CSV_CONNECTOR_ID = 'csv';

export function withCsvDefaults(d: ConnectorProviderDefinition): ConnectorProviderDefinition {
  return { ...d, response: { ...(d.response ?? {}), format: 'csv' } };
}

export function validateCsv(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const base = validateRestJson(withCsvDefaults(d));
  if (d.response?.format && d.response.format !== 'csv') base.errors.push('a CSV source is CSV');
  if (d.response?.csv?.header === false && !d.response.csv.columns?.length)
    base.errors.push('response.csv.header is false but no columns are named');
  if (d.pagination && d.pagination.strategy !== 'none')
    base.warnings.push('pagination over CSV works only with page-number or offset-limit parameters the server honours');
  return { ...base, ok: base.errors.length === 0 };
}

export const csvConnector: Connector = {
  metadata: {
    id: CSV_CONNECTOR_ID,
    name: 'CSV',
    description: 'Poll an HTTPS CSV file; each row is an object, columns by header.',
    uses: ['endpoint', 'response', 'mapping'],
    dataset: 'LIVE_OBJECTS',
  },
  validate: validateCsv,
  createProvider: (d) => new RestJsonProvider(withCsvDefaults(d), 'CSV'),
};
