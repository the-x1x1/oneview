import { Button, EmptyState, FieldList, Panel, Section, StatusBadge, canScrub, formatCursor, formatDuration, formatObjectType, formatUtcDateTime, mergedAvailability } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';

const RANGE_PRESETS: Array<{ label: string; ms: number }> = [{ label: '1 h', ms: 3600_000 }, { label: '6 h', ms: 6 * 3600_000 }, { label: '24 h', ms: 24 * 3600_000 }, { label: '7 d', ms: 7 * 24 * 3600_000 }];

/** Timeline tab: mode, cursor, visible range presets and per-type availability — the honest view of what history exists. */
export function TimelinePanel() {
  const { timeline } = useAppState();
  const actions = useActions();
  const c = timeline.control;
  const merged = mergedAvailability(c.availability);
  const scrubbable = canScrub(c);

  return (
    <Panel title="Timeline" subtitle={c.mode === 'LIVE' ? 'Following live data' : `Cursor ${formatCursor(c.cursorMs, c.nowMs)}`}>
      <Section title="Playback">
        <div className="wv-ctx-badges">
          <StatusBadge kind="freshness" value={c.mode === 'LIVE' ? 'LIVE' : 'HISTORICAL'} />
          <span className="wv-ctx-muted">{c.mode} · {c.speed}×</span>
        </div>
        <div className="wv-ctx-actions">
          {c.mode !== 'LIVE' ? <Button size="sm" icon="live" variant="primary" onClick={() => actions.timeline({ type: 'jumpToLive' })}>Jump to live</Button> : null}
          <Button size="sm" icon={c.mode === 'LIVE' || c.mode === 'REPLAY' ? 'pause' : 'play'} onClick={() => actions.timeline({ type: 'togglePlay' })}>{c.mode === 'LIVE' || c.mode === 'REPLAY' ? 'Pause' : 'Play'}</Button>
          {scrubbable && merged[0] ? <Button size="sm" icon="history" onClick={() => actions.timeline({ type: 'scrubTo', ms: merged[0]!.startMs })}>Earliest available</Button> : null}
        </div>
      </Section>
      <Section title="Visible range">
        <div className="wv-ctx-actions">
          {RANGE_PRESETS.map((p) => (
            <Button key={p.label} size="sm" pressed={Math.abs(c.range.endMs - c.range.startMs - p.ms) < 60_000} onClick={() => actions.timeline({ type: 'setRange', range: { startMs: c.nowMs - p.ms, endMs: c.nowMs } })}>{p.label}</Button>
          ))}
        </div>
        <FieldList rows={[{ label: 'From', value: formatUtcDateTime(c.range.startMs) }, { label: 'To', value: formatUtcDateTime(c.range.endMs) }]} />
      </Section>
      <Section title="History availability">
        {scrubbable ? (
          <ul className="wv-availability">
            {c.availability.filter((r) => r.ranges.length).map((r) => (
              <li key={r.objectType}>
                <span className="wv-availability__type">{formatObjectType(r.objectType)}</span>
                <span className="wv-availability__ranges wv-num">{r.ranges.map((x) => `${formatUtcDateTime(x.startMs)} → ${formatUtcDateTime(x.endMs)} (${formatDuration(x.endMs - x.startMs)})`).join('; ')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState compact icon="history" title="No history has been recorded yet" description="Only types with a recorded window can be scrubbed. The timeline will never show a past that is not stored." />
        )}
      </Section>
    </Panel>
  );
}
