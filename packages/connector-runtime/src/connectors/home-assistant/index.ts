/**
 * Home Assistant (phase `home-assistant`): the `home-assistant` connector — the operator's
 * own instance, read-only, `/api/states` then `state_changed` over the WebSocket API — and
 * the entity reading it is built on.
 *
 * Exported by name, with an HA prefix where the module's own name is generic, so this slot
 * cannot collide with another phase's exports from the package index.
 */
export {
  HA_ALLOWED_FRAMES,
  HA_AUTH_TIMEOUT_MS,
  HA_DEFAULT_PORT,
  HA_LOOPBACK_HOST,
  HA_MAX_ENTITIES,
  HA_MAX_MESSAGE_BYTES,
  HA_MAX_STATES_BYTES,
  HA_PING_MS,
  HA_REFUSED_RETRY_MS,
  HA_RESYNC_MS,
  HA_SETTINGS,
  HA_SOCKET_STATES,
  HA_SILENCE_MS,
  HOME_ASSISTANT_CONNECTOR_ID,
  HomeAssistantProvider,
  haEndpoint,
  haTokenKey,
  homeAssistantConnector,
  homeAssistantManifest,
  parseHaSettings,
  validateHomeAssistant,
  type HaAuthFrame,
  type HaEndpoint,
  type HaEndpointOk,
  type HaOutgoingFrame,
  type HaPingFrame,
  type HaSettings,
  type HaSocketState,
  type HaSubscribeFrame,
  type HomeAssistantOptions,
  type Timers as HaTimers,
} from './home-assistant.js';
export {
  ENTITY_ID as HA_ENTITY_ID,
  MAX_POSITIONS as HA_MAX_POSITIONS,
  MAX_SELECTORS as HA_MAX_SELECTORS,
  REFUSED_DOMAINS as HA_REFUSED_DOMAINS,
  attributePosition as haAttributePosition,
  enrich as enrichHaState,
  isRefused as isRefusedHaEntity,
  parsePositions as parseHaPositions,
  parseSelectors as parseHaSelectors,
  readState as readHaState,
  toSi as haToSi,
  type EntitySelector as HaEntitySelector,
  type HaState,
  type PositionEntry as HaPositionEntry,
} from './entities.js';
