import type { WorldProvider } from '@worldview/provider-sdk';
import type { ConnectorProviderDefinition } from './definition.js';

/**
 * A connector is a reusable protocol or format: one implementation, any number of
 * configured providers (directive §4–5). Given a definition it returns an ordinary
 * `WorldProvider`, which the provider host runs exactly like a hand-written one: through
 * `ProviderContext` (http, sockets, credentials, settings), under the manifest the
 * definition amounts to. The connector never reaches the network itself.
 */
export interface ConnectorMetadata {
  /** Stable id (`rest-json`, `geojson`, …). */
  id: string;
  name: string;
  description: string;
  /** Which definition fields this connector reads, for the validator and the docs. */
  uses: Array<'endpoint' | 'websocket' | 'pagination' | 'response' | 'mapping'>;
  /** Directive §92: what kind of data the connector delivers. */
  dataset: 'LIVE_OBJECTS' | 'EVENT_STREAM' | 'STATIC_FEATURES';
}

export interface ConnectorValidationResult {
  ok: boolean;
  /** Problems that stop the definition from running. */
  errors: string[];
  /** Things worth knowing that do not. */
  warnings: string[];
}

export interface Connector {
  readonly metadata: ConnectorMetadata;
  /** Connector-specific checks beyond the definition schema (the schema has already passed). */
  validate(definition: ConnectorProviderDefinition): ConnectorValidationResult;
  /** A fresh provider for this definition. */
  createProvider(definition: ConnectorProviderDefinition): WorldProvider;
}

export function validationOk(warnings: string[] = []): ConnectorValidationResult {
  return { ok: true, errors: [], warnings };
}
