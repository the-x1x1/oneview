import { clampBounds, type GeoBounds } from '@worldview/world-model';

/**
 * Below this zoom the shell subscribes to the whole world. The renderers cull what is off
 * screen on the GPU, and a globe-sized subscription never has to change while the camera
 * moves. It used to be 3 — the edge of the global band — which bounded every continental
 * view: each zoom across it swapped the full ~8,000-object mirror for a regional one and back
 * again, and a tilted globe lost the satellites in its sky because their ground points lay
 * outside the ground the camera could see.
 */
export const BOUNDED_SUBSCRIPTION_MIN_ZOOM = 6;

/**
 * Objects per page of a subscription snapshot. A world object is about 1.3 KB of JSON, so a
 * page is about a megabyte — the same size world deltas are split to (shared/event-wire.ts)
 * — and a few milliseconds to receive and parse. Zooming out past the regional band used to
 * bring ~22,700 objects in one message: 160–200 ms on the page's main thread, measured.
 */
export const SNAPSHOT_PAGE_SIZE = 1_000;

/** How far past the view a bounded subscription reaches, as a share of the view's size on each side. */
const PAD = 0.5;
/** A subscription more than this many times the padded view's area is narrowed on the next change. */
const MAX_AREA_RATIO = 9;

/**
 * The bounds the shell should be subscribed to for `view`, given what it is subscribed to now.
 *
 * `undefined` is the whole world. Otherwise the result is `current` itself for as long as it
 * still contains the view and is not far larger than it — so panning and zooming inside it
 * ask for nothing (every new subscription is a full snapshot, and a replaced mirror) — and a
 * fresh padded box when it does not. The returned object's identity is what callers key on.
 */
export function nextSubscriptionBounds(
  current: GeoBounds | undefined,
  view: { bounds?: GeoBounds | undefined; zoom: number },
): GeoBounds | undefined {
  const b = view.bounds;
  if (!b || view.zoom < BOUNDED_SUBSCRIPTION_MIN_ZOOM) return undefined;
  const padded = pad(b);
  if (current && containsBounds(current, b) && area(current) <= MAX_AREA_RATIO * area(padded)) return current;
  return padded;
}

function lonSpan(b: GeoBounds): number {
  return b.west <= b.east ? b.east - b.west : b.east + 360 - b.west;
}

function area(b: GeoBounds): number {
  return lonSpan(b) * (b.north - b.south);
}

function pad(b: GeoBounds): GeoBounds {
  const dLat = Math.max(0.25, (b.north - b.south) * PAD);
  const span = lonSpan(b);
  const dLon = Math.max(0.25, span * PAD);
  const south = Math.max(-90, b.south - dLat);
  const north = Math.min(90, b.north + dLat);
  if (span + 2 * dLon >= 360) return { west: -180, east: 180, south, north };
  const west = wrap(b.west - dLon);
  const east = wrap(b.east + dLon);
  return clampBounds({ west, east, south, north });
}

function wrap(lon: number): number {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lon > 0 ? 180 : w;
}

/** Whether `outer` covers all of `inner`, antimeridian-crossing boxes included. */
export function containsBounds(outer: GeoBounds, inner: GeoBounds): boolean {
  if (inner.south < outer.south || inner.north > outer.north) return false;
  const outerSpan = lonSpan(outer);
  if (outerSpan >= 360) return true;
  const offset = (((inner.west - outer.west) % 360) + 360) % 360;
  return offset + lonSpan(inner) <= outerSpan + 1e-9;
}

/**
 * The selected object's id, when the subscription has to name it to keep receiving it —
 * otherwise `undefined`.
 *
 * Pinning keeps a selection that lies outside the subscribed bounds, or outside the lens's
 * types, flowing. A whole-world subscription that already covers its type gains nothing
 * from the pin, and asking for one is a new subscription: selecting a satellite on the globe
 * re-sent all ~8,000 objects — ~290 ms on the page's main thread, measured — for nothing.
 */
export function pinnedSelection(input: {
  selectedId: string | null;
  selectedKind: 'object' | 'event' | null;
  /** Undefined while the selected object has not arrived: pin, to be safe. */
  selectedType: string | undefined;
  bounded: boolean;
  lensTypes: readonly string[] | undefined;
}): string | undefined {
  if (input.selectedKind !== 'object' || !input.selectedId) return undefined;
  if (input.bounded || input.selectedType === undefined) return input.selectedId;
  const coveredByLens = !input.lensTypes?.length || input.lensTypes.includes(input.selectedType);
  return coveredByLens ? undefined : input.selectedId;
}
