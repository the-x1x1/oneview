import type { CatalogPack } from '../packs/types.js';
import { caltransPack } from './caltrans.js';
import { austinPack, iowaPack, nycPack, nztaPack } from './us-cities.js';
import { wsdotPack } from './wsdot.js';
import { lithuaniaPack } from './lithuania.js';
import { US_511_PACKS } from './us-511.js';

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
  nztaPack,
  wsdotPack,
  lithuaniaPack,
  ...US_511_PACKS,
]);
