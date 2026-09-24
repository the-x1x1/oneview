import type { WorldProvider } from '@worldview/provider-sdk';
import {
  parseDefinition,
  type Connector,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
} from '@worldview/connector-sdk';
import { restJsonConnector } from './connectors/rest-json.js';
import { webSocketJsonConnector } from './connectors/websocket-json.js';
import { geoJsonConnector } from './connectors/geojson.js';
import { csvConnector } from './connectors/csv.js';
import { arcgisFeatureConnector } from './connectors/arcgis/index.js'; // phase:arcgis

/**
 * The connector registry: stable ids to implementations (directive §8). Wave 1 ships
 * rest-json, websocket-json, geojson and csv; the phases in docs/roadmap/phases add the OGC
 * family, ArcGIS, STAC, MQTT and the local-system connectors, each under the id the
 * directive names. Each phase fills its own slot below (the `phase:` comment), so branches
 * built at the same time merge without touching each other's lines.
 */
export const BUILT_IN_CONNECTORS: readonly Connector[] = Object.freeze([
  restJsonConnector,
  webSocketJsonConnector,
  geoJsonConnector,
  csvConnector,

  // phase:ogc — wfs, ogc-features, wms, wmts

  arcgisFeatureConnector, // phase:arcgis — arcgis-feature

  // phase:stac — stac

  // phase:files — local-file, gdal-import

  // phase:mqtt — mqtt (and the rtl_433 preset definitions)

  // phase:home-assistant — home-assistant

  // phase:traccar — traccar

  // phase:ingest — http-ingest
]);

export class ConnectorRegistry {
  private readonly byId = new Map<string, Connector>();

  constructor(connectors: readonly Connector[] = BUILT_IN_CONNECTORS) {
    for (const c of connectors) this.register(c);
  }

  register(connector: Connector): void {
    if (this.byId.has(connector.metadata.id)) throw new Error(`connector ${connector.metadata.id} registered twice`);
    this.byId.set(connector.metadata.id, connector);
  }
  get(id: string): Connector | undefined {
    return this.byId.get(id);
  }
  ids(): string[] {
    return [...this.byId.keys()].sort();
  }
  list(): Connector[] {
    return this.ids().map((id) => this.byId.get(id)!);
  }

  /**
   * Check a definition document end to end: the schema, then the connector's own checks.
   * A definition that passes here is one `createProvider` accepts.
   */
  validate(doc: unknown): ConnectorValidationResult & { definition?: ConnectorProviderDefinition } {
    const parsed = parseDefinition(doc);
    if (!parsed.ok) return { ok: false, errors: parsed.issues, warnings: [] };
    const d = parsed.definition;
    const connector = this.byId.get(d.connector);
    if (!connector)
      return {
        ok: false,
        errors: [`unknown connector "${d.connector}" (have: ${this.ids().join(', ')})`],
        warnings: [],
        definition: d,
      };
    const r = connector.validate(d);
    return { ...r, definition: d };
  }

  /** A provider for a definition that has passed `validate`. */
  createProvider(definition: ConnectorProviderDefinition): WorldProvider {
    const connector = this.byId.get(definition.connector);
    if (!connector) throw new Error(`unknown connector "${definition.connector}"`);
    return connector.createProvider(definition);
  }
}

export const defaultConnectorRegistry = new ConnectorRegistry();
