import type { ViewState } from './contract.js';
import { destinationPoint } from './motion.js';

/**
 * The view one renderer hands the other on a 2D/3D switch, so the same ground stays in the
 * middle of the screen. The two read `center` differently (ViewState.focus): the 2D map's is
 * the middle of the screen, the globe's the point under its camera. Handed over as it was, a
 * tilted view moved by altitude ÷ tan(tilt) on every switch: 40 km at 255 km up over Kyushu
 * on 2026-10-03, with the selected aircraft pushed to the edge of the globe's view.
 */
export function viewForMode(view: ViewState, to: '2D' | '3D'): ViewState {
  if (to === '2D') {
    if (!view.focus) return view;
    const { focus, ...rest } = view;
    return { ...rest, center: { latitude: focus.latitude, longitude: focus.longitude } };
  }
  // To the globe: put the camera behind the middle of the 2D view, along its heading, so it
  // looks at that middle at the same tilt. Straight down needs no move.
  const tilt = -view.pitchDegrees;
  if (!(tilt > 0) || tilt >= 89.5 || !(view.altitudeM > 0)) return view;
  const groundM = view.altitudeM / Math.tan((tilt * Math.PI) / 180);
  // Beyond a quarter of the Earth's circumference the middle of the view is sky: leave it.
  if (groundM > 10_000_000) return view;
  const camera = destinationPoint(view.center, (view.headingDegrees + 180) % 360, groundM);
  return {
    ...view,
    center: { latitude: camera.latitude, longitude: camera.longitude },
    focus: { latitude: view.center.latitude, longitude: view.center.longitude },
  };
}
