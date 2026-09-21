/**
 * Timeline control logic (directive §53 bottom bar). Pure reducer, tested without a DOM.
 *
 * Invariants (never pretend history exists):
 *  - the cursor can never be later than `now`;
 *  - the cursor can only leave `now` into a time covered by an availability window
 *    (the union of all object types' ranges); scrubbing snaps to the nearest covered time;
 *  - with no availability at all, scrubbing is a no-op and the control reports `canScrub=false`.
 */
export type TimelineMode = 'LIVE' | 'PAUSED' | 'REPLAY' | 'HISTORICAL';
export type TimelineSpeed = 0.25 | 1 | 5 | 20 | 60;
export const TIMELINE_SPEEDS: readonly TimelineSpeed[] = [0.25, 1, 5, 20, 60];

export interface MsRange { startMs: number; endMs: number }
export interface AvailabilityRow { objectType: string; ranges: MsRange[] }

export interface TimelineControlState {
  mode: TimelineMode;
  nowMs: number;
  cursorMs: number;
  speed: TimelineSpeed;
  range: MsRange;
  availability: AvailabilityRow[];
  /** True while the user drags the handle; `cursorMs` follows the pointer, the runtime is not updated until scrubEnd. */
  scrubbing: boolean;
}

export type TimelineAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'togglePlay' }
  | { type: 'setSpeed'; speed: TimelineSpeed }
  | { type: 'jumpToLive' }
  | { type: 'scrubStart' }
  | { type: 'scrubTo'; ms: number }
  | { type: 'scrubEnd' }
  | { type: 'step'; deltaMs: number }
  | { type: 'setRange'; range: MsRange }
  | { type: 'tick'; nowMs: number }
  | { type: 'sync'; mode: TimelineMode; cursorMs: number; speed: TimelineSpeed; range: MsRange; availability: AvailabilityRow[]; nowMs: number };

export function initialTimelineState(nowMs: number, rangeMs = 24 * 3600 * 1000): TimelineControlState {
  return { mode: 'LIVE', nowMs, cursorMs: nowMs, speed: 1, range: { startMs: nowMs - rangeMs, endMs: nowMs }, availability: [], scrubbing: false };
}

/** Union of availability windows, merged and sorted. */
export function mergedAvailability(rows: ReadonlyArray<AvailabilityRow>): MsRange[] {
  const all = rows.flatMap((r) => r.ranges).filter((r) => Number.isFinite(r.startMs) && Number.isFinite(r.endMs) && r.endMs >= r.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: MsRange[] = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

/** Nearest time within any availability window (or `now`, which is always allowed). */
export function clampToAvailability(ms: number, rows: ReadonlyArray<AvailabilityRow>, nowMs: number): { ms: number; snapped: boolean } {
  if (ms >= nowMs) return { ms: nowMs, snapped: ms !== nowMs };
  const windows = mergedAvailability(rows);
  if (windows.length === 0) return { ms: nowMs, snapped: true };
  let best = nowMs, bestDist = Math.abs(nowMs - ms);
  for (const w of windows) {
    const start = w.startMs, end = Math.min(w.endMs, nowMs);
    if (end < start) continue;
    const candidate = ms < start ? start : ms > end ? end : ms;
    const dist = Math.abs(candidate - ms);
    if (dist < bestDist) { best = candidate; bestDist = dist; }
  }
  return { ms: best, snapped: best !== ms };
}

export function canScrub(state: Pick<TimelineControlState, 'availability'>): boolean {
  return mergedAvailability(state.availability).length > 0;
}

export function fractionToMs(fraction: number, range: MsRange): number {
  const f = Math.max(0, Math.min(1, fraction));
  return Math.round(range.startMs + f * (range.endMs - range.startMs));
}

export function msToFraction(ms: number, range: MsRange): number {
  const span = range.endMs - range.startMs;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (ms - range.startMs) / span));
}

function modeForCursor(cursorMs: number, nowMs: number, playing: boolean): TimelineMode {
  if (cursorMs >= nowMs) return 'LIVE';
  return playing ? 'REPLAY' : 'HISTORICAL';
}

export function timelineReducer(state: TimelineControlState, action: TimelineAction): TimelineControlState {
  switch (action.type) {
    case 'play': {
      if (state.mode === 'LIVE' || state.mode === 'REPLAY') return state;
      if (state.cursorMs >= state.nowMs) return { ...state, mode: 'LIVE', cursorMs: state.nowMs };
      return { ...state, mode: 'REPLAY' };
    }
    case 'pause': {
      if (state.mode === 'PAUSED') return state;
      return { ...state, mode: 'PAUSED' };
    }
    case 'togglePlay':
      return timelineReducer(state, { type: state.mode === 'LIVE' || state.mode === 'REPLAY' ? 'pause' : 'play' });
    case 'setSpeed':
      return TIMELINE_SPEEDS.includes(action.speed) && action.speed !== state.speed ? { ...state, speed: action.speed } : state;
    case 'jumpToLive':
      return { ...state, mode: 'LIVE', cursorMs: state.nowMs, scrubbing: false };
    case 'scrubStart':
      return canScrub(state) ? { ...state, scrubbing: true } : state;
    case 'scrubTo': {
      if (!canScrub(state)) return state;
      const { ms } = clampToAvailability(action.ms, state.availability, state.nowMs);
      if (ms === state.cursorMs) return state;
      // Leaving LIVE by scrubbing lands in HISTORICAL (paused at that time); an active REPLAY keeps playing.
      return { ...state, cursorMs: ms, mode: state.scrubbing ? state.mode : modeForCursor(ms, state.nowMs, state.mode === 'REPLAY') };
    }
    case 'scrubEnd': {
      if (!state.scrubbing) return state;
      return { ...state, scrubbing: false, mode: modeForCursor(state.cursorMs, state.nowMs, state.mode === 'REPLAY') };
    }
    case 'step':
      return timelineReducer(state, { type: 'scrubTo', ms: state.cursorMs + action.deltaMs });
    case 'setRange': {
      if (action.range.endMs <= action.range.startMs) return state;
      return { ...state, range: { startMs: action.range.startMs, endMs: Math.min(action.range.endMs, state.nowMs) } };
    }
    case 'tick': {
      const dt = Math.max(0, action.nowMs - state.nowMs);
      let next: TimelineControlState = { ...state, nowMs: action.nowMs };
      if (state.range.endMs >= state.nowMs) next.range = { startMs: state.range.startMs + dt, endMs: action.nowMs };
      if (state.scrubbing) return next;
      if (state.mode === 'LIVE') next.cursorMs = action.nowMs;
      else if (state.mode === 'REPLAY') {
        const advanced = state.cursorMs + dt * state.speed;
        if (advanced >= action.nowMs) next = { ...next, cursorMs: action.nowMs, mode: 'LIVE' };
        else next.cursorMs = advanced;
      }
      return next;
    }
    case 'sync':
      return { ...state, mode: action.mode, cursorMs: Math.min(action.cursorMs, action.nowMs), speed: action.speed, range: action.range, availability: action.availability, nowMs: action.nowMs, scrubbing: false };
  }
}

/** Formats the cursor for the control: `HH:MM:SS UTC` plus a date when not today. */
export function formatCursor(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const time = d.toISOString().slice(11, 19);
  const sameDay = new Date(nowMs).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  return sameDay ? `${time} UTC` : `${d.toISOString().slice(0, 10)} ${time} UTC`;
}
