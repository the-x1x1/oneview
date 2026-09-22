/**
 * Google Photorealistic 3D Tiles — OPTIONAL adapter (ADR-001 §5, legal review C-9 /
 * E-8). It constructs a tileset only when the user's own key resolves from a
 * `credentialRef`; it is never a default, never bundled with a key, and the
 * history store denies persistence for `google-*` providers. Google content is
 * never cached by WORLDVIEW (Cesium's in-memory tile cache is the only cache).
 *
 * Deliberately NOT ported from gods-eye-view src/maps/google3d.js: the ion-hosted
 * route and Google-first startup selection are out of scope.
 */
import type { CesiumLike, TilesetLike } from './cesium-like.js';

export type CredentialResolver = (ref: string) => Promise<string | undefined>;

export interface Google3DOptions {
  /** Reference into secure storage (never the key itself). */
  credentialRef: string;
  resolveCredential: CredentialResolver;
}

export const GOOGLE_3D_ATTRIBUTION = 'Google';

export function google3dAvailability(opts: Partial<Google3DOptions> | undefined): {
  available: boolean;
  reason?: string;
} {
  if (!opts?.credentialRef || !opts.resolveCredential)
    return {
      available: false,
      reason: 'Google Photorealistic 3D Tiles need your own Google Maps Platform key (Settings → Map providers)',
    };
  return { available: true };
}

export async function createGoogle3DTileset(
  cesium: Pick<CesiumLike, 'createGooglePhotorealistic3DTileset'>,
  opts: Google3DOptions,
  ctx: { signal: AbortSignal },
): Promise<TilesetLike> {
  const key = (await opts.resolveCredential(opts.credentialRef))?.trim();
  ctx.signal.throwIfAborted();
  if (!key) throw new Error('Google Photorealistic 3D Tiles: no key stored for the configured credential');
  return cesium.createGooglePhotorealistic3DTileset({ key, onlyUsingWithGoogleGeocoder: true });
}
