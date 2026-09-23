import type { WorldProvider } from '@worldview/provider-sdk';
import { createProvider as createCamerasLocal } from '@worldview/provider-cameras-local';
import {
  createProvider as createPublicCameras,
  createUnverifiedProvider as createUnverifiedCameras,
} from '@worldview/provider-cctv-public';

/**
 * Camera workstream factories (partial registry map). The registry index merges the
 * per-workstream maps into the full `providerFactories` record.
 */
export const cameraProviderFactories: Readonly<Record<string, () => WorldProvider>> = Object.freeze({
  'cameras-local': createCamerasLocal,
  'public-cameras': createPublicCameras,
  'public-cameras-unverified': createUnverifiedCameras,
});
