import { parseDefinition, type ConnectorProviderDefinition, type MqttSpec } from '@worldview/connector-sdk';

/**
 * The `mqtt` block now lives in the definition schema (ADR-013 amendment M1,
 * `@worldview/connector-sdk` `mqtt.ts`); this module re-exports it for the connector and
 * its tests.
 */
export {
  MQTT_PRESETS,
  MAX_MQTT_TOPICS,
  MAX_POSITION_TABLE,
  DEFAULT_MQTT_FLUSH_MS,
  MAX_MQTT_PAYLOAD_BYTES,
  MAX_MQTT_MESSAGES_PER_SECOND,
  mqttSpecSchema,
  checkMqttDefinition,
  type MqttPreset,
  type MqttTopicSpec,
  type MqttSpec,
} from '@worldview/connector-sdk';

/** A definition that runs on the `mqtt` connector. */
export type MqttConnectorDefinition = ConnectorProviderDefinition;

/** A definition document read with the `mqtt` block (the definition schema itself, since M1). */
export const parseMqttDefinition = parseDefinition;

/** The `mqtt` block of a definition. */
export function mqttSpecOf(d: ConnectorProviderDefinition): MqttSpec | undefined {
  return d.mqtt;
}
