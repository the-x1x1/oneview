/**
 * Which markers the Earth hides from the camera, decided on the CPU.
 *
 * Markers used to be depth-tested against the globe (`disableDepthTestDistance: 0`) so that
 * the ones on the far side of the planet would not draw through it. The depth test is per
 * pixel, though, and a dot is a small square of pixels standing on the surface: seen at
 * an angle — anywhere away from the centre of the view, and most of all towards the limb —
 * the ground in front of the dot's anchor is nearer to the camera than the anchor, and it
 * cut the lower part of the dot away. The operator saw it as dots that were "not full
 * dots depending where I am on the globe".
 *
 * So the depth test is off (see layers/depth.ts) and this decides visibility per marker
 * instead: a point is hidden only when the ellipsoid lies between it and the camera. It is
 * the test Cesium's own `EllipsoidalOccluder.isScaledSpacePointVisible` makes, done in the
 * ellipsoid's scaled space, where the Earth is a unit sphere and the horizon is a cone.
 * It is a handful of multiplications per marker, so every marker can be re-tested on
 * every frame the camera moves.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** WGS84, the ellipsoid Cesium's globe is drawn on. */
export const WGS84_RADII: Vec3 = { x: 6_378_137, y: 6_378_137, z: 6_356_752.314_245_179 };

export type HorizonTest = (position: Vec3) => boolean;

/** Every point is visible: the test before the camera is known. */
export const ALWAYS_VISIBLE: HorizonTest = () => true;

/**
 * A test for one camera position (Earth-fixed, metres). The returned function answers
 * whether a point is on the camera's side of the horizon. A camera inside the ellipsoid —
 * only possible with collision detection off — has no horizon to test against, and sees
 * everything rather than guessing.
 */
export function horizonTest(camera: Vec3, radii: Vec3 = WGS84_RADII): HorizonTest {
  const cx = camera.x / radii.x;
  const cy = camera.y / radii.y;
  const cz = camera.z / radii.z;
  // Squared distance from the camera to the horizon, in scaled space.
  const horizon2 = cx * cx + cy * cy + cz * cz - 1;
  if (!(horizon2 > 0)) return ALWAYS_VISIBLE;
  return (p) => {
    const vx = p.x / radii.x - cx;
    const vy = p.y / radii.y - cy;
    const vz = p.z / radii.z - cz;
    // How far the point lies towards the Earth's centre along the camera's line to it.
    const along = -(vx * cx + vy * cy + vz * cz);
    if (along <= horizon2) return true;
    const len2 = vx * vx + vy * vy + vz * vz;
    return (along * along) / len2 <= horizon2;
  };
}

/** Whether the camera has moved far enough (metres) that the horizon has to be recomputed. */
export function cameraMoved(a: Vec3 | undefined, b: Vec3, toleranceM = 1): boolean {
  if (!a) return true;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz > toleranceM * toleranceM;
}
