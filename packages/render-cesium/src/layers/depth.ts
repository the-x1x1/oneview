/**
 * How markers are depth-tested against the globe: they are not. Visibility behind the
 * planet is decided on the CPU instead (horizon.ts).
 *
 * Cesium's `disableDepthTestDistance` is the distance from the camera within which a
 * billboard, point or label skips the depth test. The history of this constant:
 *
 *   - `Number.POSITIVE_INFINITY` at first — no depth test at any distance — so a marker on
 *     the far side of the planet drew straight through it, and on a world view the visible
 *     hemisphere was covered in objects physically behind it.
 *   - `0` next — the full depth test — which hid the far side, but per pixel. A dot is a
 *     small square of pixels standing on the surface; seen at an angle, the ground in front
 *     of its anchor is nearer the camera than the anchor and cut the lower part of the dot
 *     away. Towards the limb most dots were half dots ("not full dots depending where I am
 *     on the globe", the operator's words).
 *   - `Number.POSITIVE_INFINITY` again now, with the far side handled properly: each marker
 *     is tested against the ellipsoid's horizon from the camera's position whenever the
 *     camera moves, and hidden when the Earth is between them. Dots are whole everywhere
 *     and nothing shows through the planet.
 *
 * With real terrain a marker is not hidden behind a mountain; markers are read on top of the
 * ground, as a map's are.
 */
export const MARKER_DEPTH_TEST_DISTANCE_M = Number.POSITIVE_INFINITY;
