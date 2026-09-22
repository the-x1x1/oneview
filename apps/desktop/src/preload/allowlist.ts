import {
  EVENT_CHANNELS,
  REQUEST_CHANNELS,
  IPC_PREFIX,
  type EventChannel,
  type RequestChannel,
} from '@worldview/ipc-contract';
import { IpcRequestError, isEnvelope, type IpcResultEnvelope } from '../shared/ipc-envelope.js';

/**
 * Pure allowlist logic for the preload bridge (tested without Electron). The
 * preload is the renderer's only way to reach main, so it enforces the catalogue
 * too: a compromised renderer cannot invoke arbitrary ipcMain channels.
 */
const REQUESTS: ReadonlySet<string> = new Set(REQUEST_CHANNELS);
const EVENTS: ReadonlySet<string> = new Set(EVENT_CHANNELS);

export function isRequestChannel(name: unknown): name is RequestChannel {
  return typeof name === 'string' && REQUESTS.has(name);
}

export function isEventChannel(name: unknown): name is EventChannel {
  return typeof name === 'string' && EVENTS.has(name);
}

/** Wire name for an allowlisted channel, or undefined (never build wire names for unknown input). */
export function wireNameFor(kind: 'request' | 'event', name: unknown): string | undefined {
  if (kind === 'request' ? !isRequestChannel(name) : !isEventChannel(name)) return undefined;
  return `${IPC_PREFIX}${name}`;
}

/** Turns the main-side envelope into a value or a thrown IpcRequestError; anything else is a protocol violation. */
export function unwrapEnvelope<T>(channel: string, envelope: unknown): T {
  if (!isEnvelope(envelope))
    throw new IpcRequestError({ code: 'INTERNAL', message: 'malformed response from main process', channel });
  const e = envelope as IpcResultEnvelope<T>;
  if (e.ok) return e.value;
  throw new IpcRequestError(e.error);
}

/**
 * Only plain JSON-serialisable payloads cross the bridge: no functions, symbols,
 * class instances or prototypes the structured-clone algorithm would carry over.
 */
export function isPlainPayload(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === undefined || value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (Array.isArray(value)) return value.every((v) => isPlainPayload(v, depth + 1));
      if (value instanceof Uint8Array) return true;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value as Record<string, unknown>).every((v) => isPlainPayload(v, depth + 1));
    }
    default:
      return false;
  }
}
