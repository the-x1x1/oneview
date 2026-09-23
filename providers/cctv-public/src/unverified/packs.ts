import type { CatalogPack } from '../packs/types.js';
import { caltransPack } from './caltrans.js';
import { austinPack, iowaPack, nycPack } from './us-cities.js';

/**
 * Packs of the `public-cameras-unverified` provider: catalogues that are published for
 * anyone to read but whose camera images carry no reuse licence we could find. Each has
 * its own record in config/licenses/providers.json (`manual-review-required`); the
 * provider's policy is their intersection.
 */
export const UNVERIFIED_CAMERA_PACKS: readonly CatalogPack[] = Object.freeze([
  caltransPack,
  austinPack,
  nycPack,
  iowaPack,
]);
