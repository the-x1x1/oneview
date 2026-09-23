import { haversineMeters } from '@worldview/world-model';
import type { TrackPoint } from '../store/types.js';

/**
 * The numbers behind an object's history view (roadmap 0.3.0, "per-object history views:
 * track playback, altitude and speed profiles").
 *
 * Altitude is the recorded one. Speed is not recorded in a track point — it is derived
 * here from the positions: the distance between a fix and one at least `SPEED_WINDOW_MS`
 * and two fixes earlier, then the median of five neighbours. Straight-line distance means
 * one bad fix raises only the two samples that end or start on it (path length would raise
 * every window that crossed it), and two raised samples out of five are what a median of
 * five removes. The cost is a few per cent low through a tight turn (a standard-rate turn
 * over 20 s reads 4.5 % slow). It is labelled as derived wherever it is
 * shown. A gap longer than `GAP_MS` breaks both lines: nothing is drawn across a stretch
 * nobody observed.
 */
export const SPEED_WINDOW_MS = 20_000;
export const GAP_MS = 10 * 60_000;
/** Faster than anything tracked here (a low orbit is ~7.8 km/s): a glitch, not a speed. */
const MAX_PLAUSIBLE_MPS = 12_000;
/** Samples kept for drawing; a day of ten-second fixes is 8,640. */
export const MAX_PROFILE_SAMPLES = 1_000;

export interface ProfileSample {
  t: number;
  altitudeM?: number;
  speedMps?: number;
  /** True on the first sample after a gap: the line restarts here. */
  breakBefore: boolean;
}

export interface TrackProfile {
  startMs: number;
  endMs: number;
  samples: ProfileSample[];
  altitude?: { min: number; max: number };
  speed?: { min: number; max: number };
}

export function trackProfile(track: ReadonlyArray<TrackPoint>): TrackProfile | undefined {
  const pts = track
    .map((p) => ({ p, t: Date.parse(p.observedAt) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return undefined;

  // Where each observed stretch starts: a gap longer than GAP_MS begins a new one.
  const segStart: number[] = [0];
  for (let i = 1; i < pts.length; i++) segStart.push(pts[i]!.t - pts[i - 1]!.t > GAP_MS ? i : segStart[i - 1]!);

  const raw: Array<number | undefined> = pts.map((x, i) => {
    let j = i - 1;
    if (j < segStart[i]!) return undefined;
    while (j > segStart[i]! && (i - j < 2 || x.t - pts[j]!.t < SPEED_WINDOW_MS)) j--;
    const dt = (x.t - pts[j]!.t) / 1000;
    if (dt <= 0) return undefined;
    const v = haversineMeters(pts[j]!.p, x.p) / dt;
    return v <= MAX_PLAUSIBLE_MPS ? v : undefined;
  });
  const speed = raw.map((v, i) => {
    if (v === undefined) return undefined;
    const near: number[] = [];
    for (let k = i - 2; k <= i + 2; k++) {
      const x = raw[k];
      if (x !== undefined && segStart[k] === segStart[i]) near.push(x);
    }
    near.sort((a, b) => a - b);
    return near[Math.floor(near.length / 2)];
  });

  let samples: ProfileSample[] = pts.map((x, i) => {
    const s: ProfileSample = { t: x.t, breakBefore: i > 0 && segStart[i] === i };
    const alt = x.p.altitudeM;
    if (alt !== undefined && Number.isFinite(alt)) s.altitudeM = alt;
    const v = speed[i];
    if (v !== undefined) s.speedMps = v;
    return s;
  });
  if (samples.length > MAX_PROFILE_SAMPLES) samples = thin(samples, MAX_PROFILE_SAMPLES);

  const out: TrackProfile = { startMs: pts[0]!.t, endMs: pts[pts.length - 1]!.t, samples };
  const alts = samples.flatMap((s) => (s.altitudeM === undefined ? [] : [s.altitudeM]));
  const speeds = samples.flatMap((s) => (s.speedMps === undefined ? [] : [s.speedMps]));
  if (alts.length >= 2) out.altitude = { min: Math.min(...alts), max: Math.max(...alts) };
  if (speeds.length >= 2) out.speed = { min: Math.min(...speeds), max: Math.max(...speeds) };
  return out;
}

/** Every k-th sample, keeping the last and every line break. */
function thin(samples: ProfileSample[], max: number): ProfileSample[] {
  const k = Math.ceil(samples.length / max);
  const out: ProfileSample[] = [];
  let carryBreak = false;
  samples.forEach((s, i) => {
    carryBreak ||= s.breakBefore;
    if (i % k === 0 || i === samples.length - 1) {
      out.push(carryBreak ? { ...s, breakBefore: true } : s);
      carryBreak = false;
    }
  });
  return out;
}

/** The sample nearest `t`. */
export function sampleAt(profile: TrackProfile, t: number): ProfileSample {
  const s = profile.samples;
  let lo = 0,
    hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(s[lo]!.t - t) <= Math.abs(s[hi]!.t - t) ? s[lo]! : s[hi]!;
}

/**
 * SVG path data for one series in a `width` × `height` box: time across, value up, a
 * new sub-path after every gap or missing value.
 */
export function profilePath(
  profile: TrackProfile,
  pick: (s: ProfileSample) => number | undefined,
  range: { min: number; max: number },
  width: number,
  height: number,
): string {
  const span = Math.max(1, profile.endMs - profile.startMs);
  const vSpan = range.max - range.min;
  let d = '';
  let pen = false;
  for (const s of profile.samples) {
    const v = pick(s);
    if (v === undefined || s.breakBefore) pen = false;
    if (v === undefined) continue;
    const x = ((s.t - profile.startMs) / span) * width;
    // A flat series sits mid-height rather than on the floor.
    const y = vSpan > 0 ? height - ((v - range.min) / vSpan) * height : height / 2;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** The replay speed that plays `spanMs` in about a minute and a half, from the timeline's speeds. */
export function replaySpeedFor(spanMs: number): 5 | 20 | 60 {
  if (spanMs / 5 <= 90_000) return 5;
  if (spanMs / 20 <= 90_000) return 20;
  return 60;
}

/** Track windows the history view offers. */
export const TRACK_WINDOWS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: '1 h', ms: 3_600_000 },
  { label: '6 h', ms: 6 * 3_600_000 },
  { label: '24 h', ms: 24 * 3_600_000 },
];

/**
 * The live track grown by the selected object's newest position. The track is fetched
 * once, on selection; without this the drawn trail stopped where the object was when it
 * was clicked while the object itself moved on. Only a later observation is appended, so
 * a replayed (earlier) position never is.
 */
export function extendTrack(
  track: ReadonlyArray<TrackPoint>,
  object: { observedAt: string; position?: { latitude: number; longitude: number; altitudeM?: number } },
  maxPoints = 10_000,
): TrackPoint[] | undefined {
  if (!object.position) return undefined;
  const last = track[track.length - 1];
  if (last && Date.parse(object.observedAt) <= Date.parse(last.observedAt)) return undefined;
  const point: TrackPoint = {
    observedAt: object.observedAt,
    latitude: object.position.latitude,
    longitude: object.position.longitude,
    ...(object.position.altitudeM !== undefined ? { altitudeM: object.position.altitudeM } : {}),
  };
  const next = [...track, point];
  return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
}
