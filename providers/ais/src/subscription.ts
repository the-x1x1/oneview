import { isValidBounds, type GeoBounds } from '@worldview/world-model';
import { AISSTREAM_MESSAGE_TYPES } from './manifest.js';

/**
 * AISStream subscription frame (first message after the socket opens):
 *   { APIKey, BoundingBoxes: [[[south, west], [north, east]], ...], FilterMessageTypes }
 * Boxes are [lat, lon] pairs. Bounds crossing the antimeridian are split into two boxes.
 */
export type BoundingBox = [[number, number], [number, number]];

export const WORLD_BOX: BoundingBox = [[-90, -180], [90, 180]];

export function boundingBoxesFor(bounds: GeoBounds | undefined): BoundingBox[] {
  if (!bounds || !isValidBounds(bounds)) return [WORLD_BOX];
  if (bounds.west <= bounds.east) return [[[bounds.south, bounds.west], [bounds.north, bounds.east]]];
  return [
    [[bounds.south, bounds.west], [bounds.north, 180]],
    [[bounds.south, -180], [bounds.north, bounds.east]],
  ];
}

export interface SubscriptionFrame {
  APIKey: string;
  BoundingBoxes: BoundingBox[];
  FilterMessageTypes: string[];
}

/**
 * Build the subscription payload. The API key is provided by the caller (secret resolver);
 * this module never logs or stores it.
 */
export function buildSubscriptionFrame(apiKey: string, bounds: GeoBounds | undefined, messageTypes: readonly string[] = AISSTREAM_MESSAGE_TYPES): string {
  const frame: SubscriptionFrame = { APIKey: apiKey, BoundingBoxes: boundingBoxesFor(bounds), FilterMessageTypes: [...messageTypes] };
  return JSON.stringify(frame);
}
