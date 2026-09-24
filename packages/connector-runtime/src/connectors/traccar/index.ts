/**
 * Traccar (phase `traccar`): the `traccar` connector — a Traccar server's devices as objects,
 * read by REST and, on a public server, followed live over its socket — and the directory
 * of devices, positions and events it keeps (session.ts).
 *
 * Exported by name, with a Traccar prefix where the module's own name is generic, so this
 * slot cannot collide with another phase's exports from the package index.
 */
export {
  TRACCAR_CONNECTOR_ID,
  TRACCAR_DEFAULT_PORT,
  TRACCAR_DEVICES_REFRESH_MS,
  TRACCAR_DEVICES_RETRY_MS,
  TRACCAR_LOCAL_CREDENTIAL,
  TRACCAR_LOCAL_HOST,
  TRACCAR_LOCAL_INTERVAL_SECONDS,
  TRACCAR_LOCAL_SETTINGS,
  TRACCAR_REQUESTS_PER_POLL,
  TraccarProvider,
  isLocalTraccar,
  traccarBase,
  traccarConnector,
  traccarManifest,
  validateTraccar,
  type TraccarOptions,
} from './traccar.js';
export {
  EXCLUDED_CATEGORIES as TRACCAR_EXCLUDED_CATEGORIES,
  MAX_DEVICES as TRACCAR_MAX_DEVICES,
  TraccarDirectory,
  readDevice as readTraccarDevice,
  readEvent as readTraccarEvent,
  readSocketMessage as readTraccarSocketMessage,
  type SocketMessage as TraccarSocketMessage,
  type TraccarDevice,
  type TraccarEvent,
} from './session.js';
