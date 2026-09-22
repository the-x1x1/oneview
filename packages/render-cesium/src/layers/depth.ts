/**
 * How markers are depth-tested against the globe.
 *
 * Cesium's `disableDepthTestDistance` is the distance from the camera within which a
 * billboard, point or label skips the depth test entirely. All three layer types used to
 * pass `Number.POSITIVE_INFINITY`, which switches the depth test off at every distance —
 * so a marker on the far side of the planet drew straight through the globe. On a world
 * view that is most of them: the visible hemisphere was covered in objects that are
 * physically behind it, which is both wrong and unreadable.
 *
 * Zero restores the depth test at all distances, and the near-side behaviour people
 * actually want is already handled one layer up by `Globe.depthTestAgainstTerrain`, which
 * renderer.ts sets from the active terrain:
 *
 *   - ellipsoid terrain (the default) — false, so markers still draw on top of the globe
 *     surface rather than being swallowed by it, while anything on the opposite side is
 *     correctly hidden. Cesium documents exactly this carve-out: primitives are drawn on
 *     top of terrain "unless they're on the opposite side of the globe".
 *   - real terrain — true, so a marker behind a mountain is behind the mountain.
 *
 * In other words the policy was already expressed correctly and this constant was
 * overriding it. It is a named constant rather than an omitted property so that the
 * decision is visible at each call site and asserted by the layer tests.
 */
export const MARKER_DEPTH_TEST_DISTANCE_M = 0;
