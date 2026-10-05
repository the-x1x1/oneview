/**
 * The time the world on the map is from, when that is not now: the timeline's cursor while
 * replaying or showing history. Live and paused, the runtime keeps sending the live world
 * (runtime `isLiveMode`), so it is now — undefined — and anything worked out from the objects'
 * reports (the closest point of approach, how old a report is) or drawn beside them (the night
 * side, the Sun and Moon) is for now too.
 */
export function pastShownAtMs(control: { mode: string; cursorMs: number }): number | undefined {
  return control.mode === 'REPLAY' || control.mode === 'HISTORICAL' ? control.cursorMs : undefined;
}
