import { useEffect, useState } from 'react';

/**
 * Wall-clock that re-renders the caller every `intervalMs` (default 1 s). Kept out of
 * the store so relative ages and the UTC clock do not dispatch store actions.
 * `installClock` lets tests and the demo bootstrap inject a deterministic clock.
 */
let clock: () => number = () => Date.now();

export function installClock(fn: () => number): void { clock = fn; }
export function currentTime(): number { return clock(); }

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => clock());
  useEffect(() => {
    const id = setInterval(() => setNow(clock()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
