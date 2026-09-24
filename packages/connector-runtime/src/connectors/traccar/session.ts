/**
 * What a Traccar connection knows between messages: the devices (from `/api/devices` and
 * the socket's `devices`), the last position each device reported, and the last event
 * Traccar raised for it. Positions are read against it: each becomes one record for the
 * definition's mapping, the position's own fields with three more beside them —
 *
 *   - `deviceName`: the device's name, or its id as text when the device is not known (yet);
 *   - `device`: `{ id, name, category, status, model, disabled, lastUpdate }` when known —
 *     never `uniqueId`, `phone` or `contact`, which identify a tracker or a person rather
 *     than describe the equipment;
 *   - `event`: the device's latest event, `{ type, eventTime, positionId, geofenceId, alarm }`,
 *     on the position it belongs to — the one it names, or one no newer than the event — so
 *     an alarm from an hour ago does not ride on every later fix.
 *
 * The position's `attributes.driverUniqueId` (a driver's RFID or iButton id) is dropped.
 *
 * A device whose Traccar category is `person` is left out altogether (docs/PRODUCT-BOUNDARIES.md:
 * WORLDVIEW is not a people-tracking system); its positions are counted, never mapped. This
 * fails closed: until one whole device list has been read, a position of a device no list
 * or socket message has described is held back (kept as its last, not mapped), since its
 * category cannot be known. After that, a device the list does not name — one added since —
 * is shown, labelled by its id, until the next list names it.
 */
export const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set(['person']);
export const MAX_DEVICES = 10_000;

export interface TraccarDevice {
  id: number;
  name: string;
  category?: string;
  status?: string;
  model?: string;
  disabled?: boolean;
  lastUpdate?: string;
}

export interface TraccarEvent {
  id?: number;
  deviceId: number;
  type: string;
  eventTime?: string;
  positionId?: number;
  geofenceId?: number;
  alarm?: string;
}

/** One socket message, read: its parts, or why it is not a Traccar message. */
export type SocketMessage =
  | { kind: 'update'; devices: unknown[]; positions: unknown[]; events: unknown[] }
  | { kind: 'keepalive' }
  | { kind: 'malformed'; reason: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const intOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v)
    ? v
    : typeof v === 'string' && /^-?\d{1,15}$/.test(v)
      ? Number(v)
      : undefined;
const textOf = (v: unknown, max = 256): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** A device from `/api/devices` or the socket, reduced to what describes the equipment. */
export function readDevice(raw: unknown): TraccarDevice | undefined {
  if (!isObj(raw)) return undefined;
  const id = intOf(raw['id']);
  const name = textOf(raw['name']);
  if (id === undefined || name === undefined) return undefined;
  const device: TraccarDevice = { id, name };
  const category = textOf(raw['category'], 64);
  if (category) device.category = category.toLowerCase();
  const status = textOf(raw['status'], 32);
  if (status) device.status = status;
  const model = textOf(raw['model'], 128);
  if (model) device.model = model;
  if (typeof raw['disabled'] === 'boolean') device.disabled = raw['disabled'];
  const lastUpdate = textOf(raw['lastUpdate'], 64);
  if (lastUpdate) device.lastUpdate = lastUpdate;
  return device;
}

export function readEvent(raw: unknown): TraccarEvent | undefined {
  if (!isObj(raw)) return undefined;
  const deviceId = intOf(raw['deviceId']);
  const type = textOf(raw['type'], 64);
  if (deviceId === undefined || type === undefined) return undefined;
  const event: TraccarEvent = { deviceId, type };
  const id = intOf(raw['id']);
  if (id !== undefined) event.id = id;
  const eventTime = textOf(raw['eventTime'], 64);
  if (eventTime) event.eventTime = eventTime;
  const positionId = intOf(raw['positionId']);
  if (positionId) event.positionId = positionId;
  const geofenceId = intOf(raw['geofenceId']);
  if (geofenceId) event.geofenceId = geofenceId;
  const alarm = isObj(raw['attributes']) ? textOf(raw['attributes']['alarm'], 64) : undefined;
  if (alarm) event.alarm = alarm;
  return event;
}

/**
 * A socket message: `{ devices?, positions?, events? }`, each an array when present (Traccar
 * leaves a key out when it has nothing of that kind). `{}` is Traccar's keep-alive.
 */
export function readSocketMessage(data: string | Uint8Array): SocketMessage {
  let body: unknown;
  try {
    body = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
  } catch {
    return { kind: 'malformed', reason: 'not JSON' };
  }
  if (!isObj(body)) return { kind: 'malformed', reason: 'not an object' };
  const parts: Record<'devices' | 'positions' | 'events', unknown[]> = { devices: [], positions: [], events: [] };
  let known = 0;
  for (const key of ['devices', 'positions', 'events'] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return { kind: 'malformed', reason: `${key} is not a list` };
    parts[key] = v;
    known++;
  }
  if (known === 0)
    return Object.keys(body).length === 0
      ? { kind: 'keepalive' }
      : { kind: 'malformed', reason: 'no devices, positions or events' };
  return { kind: 'update', ...parts };
}

/** Whether an event goes with a position: the one it names, or one no newer than the event. */
function belongsTo(event: TraccarEvent, position: Obj): boolean {
  if (event.positionId !== undefined && intOf(position['id']) === event.positionId) return true;
  const fix = typeof position['fixTime'] === 'string' ? Date.parse(position['fixTime']) : Number.NaN;
  const at = event.eventTime ? Date.parse(event.eventTime) : Number.NaN;
  return Number.isFinite(fix) && Number.isFinite(at) && at >= fix;
}

/** Devices, last positions and last events of one Traccar source. */
export class TraccarDirectory {
  private readonly devices = new Map<number, TraccarDevice>();
  private readonly positions = new Map<number, Obj>();
  private readonly events = new Map<number, TraccarEvent>();
  /** When the device list was last read whole (`/api/devices`). */
  devicesReadAt: number | undefined;

  /** Whether a whole device list has been read, so an unknown device is a new one rather than an unchecked one. */
  get listRead(): boolean {
    return this.devicesReadAt !== undefined;
  }

  get deviceCount(): number {
    return this.devices.size;
  }

  /** The whole list from `/api/devices`: devices no longer listed are forgotten. */
  replaceDevices(list: readonly TraccarDevice[], at: number): void {
    this.devices.clear();
    for (const d of list.slice(0, MAX_DEVICES)) this.devices.set(d.id, d);
    this.devicesReadAt = at;
  }

  /** Devices the socket reports (added or changed): merged in, capped. */
  updateDevices(list: readonly TraccarDevice[]): void {
    for (const d of list) {
      if (!this.devices.has(d.id) && this.devices.size >= MAX_DEVICES) continue;
      this.devices.set(d.id, d);
    }
  }

  device(id: number): TraccarDevice | undefined {
    return this.devices.get(id);
  }

  /** Whether a device's positions are left out (its category is `person`). */
  excluded(deviceId: number): boolean {
    const category = this.devices.get(deviceId)?.category;
    return category !== undefined && EXCLUDED_CATEGORIES.has(category);
  }

  /** Remember a device's latest event (an older one than the kept one is ignored). */
  noteEvent(event: TraccarEvent): void {
    const prior = this.events.get(event.deviceId);
    if (prior?.eventTime && event.eventTime && Date.parse(prior.eventTime) > Date.parse(event.eventTime)) return;
    if (!this.events.has(event.deviceId) && this.events.size >= MAX_DEVICES) return;
    this.events.set(event.deviceId, event);
  }

  /** The last position a device reported, as it was read. */
  lastPosition(deviceId: number): Obj | undefined {
    return this.positions.get(deviceId);
  }

  /**
   * A position as a record for the mapping, or why it is not one. The position is also kept
   * as the device's last, unless it is older than the one already kept.
   */
  record(raw: unknown): { record: Obj; deviceId: number } | { excluded: true } | { held: true } | { invalid: string } {
    if (!isObj(raw)) return { invalid: 'a position that is not an object' };
    const deviceId = intOf(raw['deviceId']);
    if (deviceId === undefined) return { invalid: 'a position without a deviceId' };
    if (this.excluded(deviceId)) return { excluded: true };
    const prior = this.positions.get(deviceId);
    const newer =
      !prior ||
      !(typeof prior['fixTime'] === 'string' && typeof raw['fixTime'] === 'string') ||
      Date.parse(raw['fixTime']) >= Date.parse(prior['fixTime']);
    if (newer && (prior || this.positions.size < MAX_DEVICES)) this.positions.set(deviceId, raw);
    if (this.held(deviceId)) return { held: true };
    return { record: this.enrich(raw, deviceId), deviceId };
  }

  /** The record of a device's last position with what is known now (after an event or a device change). */
  recordOfLast(deviceId: number): Obj | undefined {
    const raw = this.positions.get(deviceId);
    if (!raw || this.excluded(deviceId) || this.held(deviceId)) return undefined;
    return this.enrich(raw, deviceId);
  }

  /** A device whose category cannot be known yet: no whole list read, and nothing has described it. */
  private held(deviceId: number): boolean {
    return !this.listRead && !this.devices.has(deviceId);
  }

  private enrich(raw: Obj, deviceId: number): Obj {
    const device = this.devices.get(deviceId);
    const event = this.events.get(deviceId);
    const record: Obj = { ...raw, deviceName: device?.name ?? String(deviceId) };
    if (isObj(raw['attributes']) && 'driverUniqueId' in raw['attributes']) {
      const { driverUniqueId: _driver, ...attributes } = raw['attributes'];
      record['attributes'] = attributes;
    }
    if (device) record['device'] = { ...device };
    if (event && belongsTo(event, raw)) record['event'] = { ...event };
    return record;
  }
}
