import { useEffect } from 'react';
import { Timeline, formatObjectType } from '@worldview/ui';
import { useActions, useAppState, useDispatch } from '../store/store.js';
import { currentTime } from '../hooks/use-now.js';

/** Bottom timeline bar (directive §53): the pure Timeline control bound to the store; ticks once per second. */
export function TimelineBar() {
  const { timeline } = useAppState();
  const actions = useActions();
  const dispatch = useDispatch();

  useEffect(() => {
    const id = setInterval(() => dispatch({ type: 'timeline/control', action: { type: 'tick', nowMs: currentTime() } }), 1000);
    return () => clearInterval(id);
  }, [dispatch]);

  const labels = Object.fromEntries(timeline.control.availability.map((a) => [a.objectType, formatObjectType(a.objectType)]));
  return (
    <footer className="wv-timelinebar">
      <Timeline state={timeline.control} dispatch={(a) => actions.timeline(a)} typeLabels={labels} />
    </footer>
  );
}
