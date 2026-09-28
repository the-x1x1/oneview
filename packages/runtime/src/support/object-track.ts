import type { TimeRange } from '@worldview/world-model';
import type { ObjectTrackAnswer } from '@worldview/provider-sdk';
import type { WorldTrackPoint } from '@worldview/ipc-contract';

/**
 * Merging what a source says about the selected object into the track WORLDVIEW recorded
 * (`world.track` with `selected`; provider-sdk object-track.ts).
 *
 * WORLDVIEW's own points are never replaced. A source's history fills the gaps in them: a
 * point is added only where no point of ours lies within GAP_TOLERANCE_MS of it, so the
 * hour before the aircraft came into view, or a stretch while the view was elsewhere, is
 * filled, and where we recorded the aircraft ourselves the track stays ours. A prediction
 * goes after the last point of ours — it is where the object will be, not where it was —
 * and is marked `predicted`. Every added point carries its answer's label as `source`, and
 * its attribution, when the source requires one, as `sourceAttribution`.
 */
export const GAP_TOLERANCE_MS = 20_000;

export function mergeObjectTrack(
  own: readonly WorldTrackPoint[],
  answers: ReadonlyArray<ObjectTrackAnswer | undefined>,
  range: TimeRange,
): WorldTrackPoint[] {
  const ownTimes = own.map((p) => Date.parse(p.observedAt)).sort((a, b) => a - b);
  const lastOwn = ownTimes.length ? ownTimes[ownTimes.length - 1]! : -Infinity;
  const from = Date.parse(range.start);
  const to = Date.parse(range.end);
  const out: WorldTrackPoint[] = [...own];
  for (const answer of answers) {
    if (!answer) continue;
    const label = answer.attribution
      ? { source: answer.label, sourceAttribution: answer.attribution }
      : { source: answer.label };
    for (const p of answer.points) {
      const t = Date.parse(p.observedAt);
      if (!Number.isFinite(t)) continue;
      if (answer.kind === 'history') {
        if (t < from || t > to || nearest(ownTimes, t) <= GAP_TOLERANCE_MS) continue;
        out.push({ ...p, ...label });
      } else {
        if (t <= lastOwn) continue;
        out.push({ ...p, ...label, predicted: true });
      }
    }
  }
  out.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return out;
}

/** Distance (ms) from `t` to the nearest of the sorted `times`; Infinity when there are none. */
export function nearest(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  let best = Infinity;
  if (lo < times.length) best = Math.min(best, Math.abs(times[lo]! - t));
  if (lo > 0) best = Math.min(best, Math.abs(times[lo - 1]! - t));
  return best;
}
