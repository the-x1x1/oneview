import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeoBounds, WorldEvent, WorldObject } from '@worldview/world-model';
import type { WhatChangedResult } from '@worldview/ipc-contract';
import {
  Button,
  EmptyState,
  Panel,
  Section,
  StatusBadge,
  formatAgo,
  formatObjectType,
  formatUtcDateTime,
} from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { useNow } from '../hooks/use-now.js';

const WINDOWS: Array<{ label: string; hours: number }> = [
  { label: '1 h', hours: 1 },
  { label: '6 h', hours: 6 },
  { label: '24 h', hours: 24 },
  { label: '7 d', hours: 24 * 7 },
];

/** Rows per list before "and N more": a week over a continent can be thousands of events. */
export const CHANGES_LIST_LIMIT = 40;

export interface ChangeRows {
  alerts: WorldEvent[];
  /** New events that are not alerts (the alerts are listed on their own). */
  events: WorldEvent[];
  ended: WorldEvent[];
  counts: Array<{ objectType: string; before: number; after: number; delta: number }>;
  status: Array<{ objectId: string; name: string; from: string; to: string; at: string }>;
  total: number;
}

/**
 * What the panel lists, from `world.whatChanged`. Counts that moved are sorted by how far
 * they moved; status changes are named from the mirror when the object is in it (a source's
 * status change is named after the source).
 */
export function changeRows(result: WhatChangedResult, objects: ReadonlyMap<string, WorldObject>): ChangeRows {
  const alertIds = new Set(result.newAlerts.map((e) => e.id));
  const counts = result.countChanges
    .map((c) => ({ ...c, delta: c.after - c.before }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.objectType.localeCompare(b.objectType));
  const status = result.statusChanges.map((s) => {
    const o = objects.get(s.objectId);
    const name = o
      ? (o.labels['name'] ?? o.labels['callsign'] ?? o.labels['title'] ?? s.objectId)
      : s.objectId.startsWith('source:')
        ? s.objectId.slice('source:'.length)
        : s.objectId;
    return { ...s, name };
  });
  return {
    alerts: result.newAlerts,
    events: result.newEvents.filter((e) => !alertIds.has(e.id)),
    ended: result.endedEvents,
    counts,
    status,
    total: result.newEvents.length + result.endedEvents.length + counts.length + status.length,
  };
}

function boundsLabel(b: GeoBounds): string {
  const lat = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`;
  const lon = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}`;
  if (b.east - b.west >= 359 && b.north - b.south >= 170) return 'the whole world';
  return `${lat(b.south)}–${lat(b.north)}, ${lon(b.west)}–${lon(b.east)}`;
}

interface CheckState {
  status: 'idle' | 'loading' | 'done' | 'error';
  result?: WhatChangedResult;
  bounds?: GeoBounds;
  hours?: number;
  checkedAt?: number;
}

/**
 * What changed in the view (roadmap 0.3.0: "what changed" as a first-class screen). The
 * area is the view as it was when the check ran, and says so: re-running on every camera
 * move would query history for every pan. New alerts and events can be opened; counts say
 * what the comparison is between.
 */
export function ChangesPanel() {
  const { world } = useAppState();
  const actions = useActions();
  const nowMs = useNow(30_000);
  const [hours, setHours] = useState(24);
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  const seq = useRef(0);
  const viewBounds = world.view.bounds;

  const run = useCallback(
    (h: number) => {
      const id = ++seq.current;
      const bounds = viewBounds;
      setCheck((c) => ({ ...c, status: 'loading' }));
      void actions.whatChangedHere(h).then((result) => {
        if (seq.current !== id) return;
        setCheck(
          result
            ? { status: 'done', result, hours: h, checkedAt: Date.now(), ...(bounds ? { bounds } : {}) }
            : { status: 'error' },
        );
      });
    },
    [actions, viewBounds],
  );

  // Once when the panel opens, and when the window changes; not when the camera moves.
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    run(hours);
  }, [run, hours]);

  const rows = check.result ? changeRows(check.result, world.objects) : undefined;
  const moved =
    check.bounds && viewBounds
      ? ['west', 'east', 'south', 'north'].some(
          (k) => Math.abs(check.bounds![k as keyof GeoBounds] - viewBounds[k as keyof GeoBounds]) > 0.05,
        )
      : false;
  const windowLabel = WINDOWS.find((w) => w.hours === (check.hours ?? hours))?.label ?? `${hours} h`;

  const openEvent = (e: WorldEvent) => void actions.select(e.id, { kind: 'event', fly: true });
  const eventRow = (e: WorldEvent, at: string | undefined) => (
    <li key={e.id}>
      <button type="button" className="wv-changes__row" onClick={() => openEvent(e)}>
        {e.severity ? <StatusBadge kind="severity" value={e.severity} size="sm" /> : null}
        <span className="wv-changes__type">{formatObjectType(e.type)}</span>
        <span className="wv-changes__title wv-truncate">{e.title}</span>
        <span className="wv-changes__age wv-num">{at ? formatAgo(at, nowMs) : ''}</span>
      </button>
    </li>
  );
  const eventList = (list: WorldEvent[], when: (e: WorldEvent) => string | undefined) => (
    <>
      <ul className="wv-changes__list">{list.slice(0, CHANGES_LIST_LIMIT).map((e) => eventRow(e, when(e)))}</ul>
      {list.length > CHANGES_LIST_LIMIT ? (
        <p className="wv-ctx-muted">and {list.length - CHANGES_LIST_LIMIT} more — narrow the view or the window</p>
      ) : null}
    </>
  );

  return (
    <Panel
      title="What changed"
      subtitle={
        check.status === 'done' && check.bounds
          ? `In ${boundsLabel(check.bounds)} · last ${windowLabel}`
          : `In the current view · last ${windowLabel}`
      }
    >
      <Section title="Window">
        <div className="wv-ctx-actions">
          {WINDOWS.map((w) => (
            <Button
              key={w.label}
              size="sm"
              pressed={hours === w.hours}
              onClick={() => {
                setHours(w.hours);
                run(w.hours);
              }}
            >
              {w.label}
            </Button>
          ))}
          <Button size="sm" icon="refresh" onClick={() => run(hours)} disabled={check.status === 'loading'}>
            {moved ? 'Check this view' : 'Check again'}
          </Button>
        </div>
        {check.checkedAt ? (
          <p className="wv-ctx-muted">
            Checked {formatUtcDateTime(check.checkedAt)}
            {moved ? ' — the view has moved since' : ''}
          </p>
        ) : null}
      </Section>

      {check.status === 'loading' && !rows ? <p className="wv-ctx-muted">Checking…</p> : null}
      {check.status === 'error' ? (
        <EmptyState
          compact
          icon="warning"
          title="Could not check"
          description="The comparison did not complete; the reason is in the notification."
        />
      ) : null}
      {rows && rows.total === 0 ? (
        <EmptyState
          compact
          icon="activity"
          title="Nothing changed"
          description={`No new or ended events, and no change in what is here, in the last ${windowLabel}.`}
        />
      ) : null}

      {rows && rows.alerts.length ? (
        <Section title={`New alerts (${rows.alerts.length})`}>{eventList(rows.alerts, (e) => e.startAt)}</Section>
      ) : null}
      {rows && rows.events.length ? (
        <Section title={`New events (${rows.events.length})`}>{eventList(rows.events, (e) => e.startAt)}</Section>
      ) : null}
      {rows && rows.ended.length ? (
        <Section title={`Ended (${rows.ended.length})`}>{eventList(rows.ended, (e) => e.endAt)}</Section>
      ) : null}
      {rows && rows.counts.length ? (
        <Section title="Counts">
          <table className="wv-changes__counts">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Then</th>
                <th scope="col">Now</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.counts.map((c) => (
                <tr key={c.objectType}>
                  <td>{formatObjectType(c.objectType)}</td>
                  <td className="wv-num">{c.before.toLocaleString('en-US')}</td>
                  <td className="wv-num">{c.after.toLocaleString('en-US')}</td>
                  <td className="wv-num">
                    {c.delta > 0 ? '+' : ''}
                    {c.delta.toLocaleString('en-US')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="wv-ctx-muted">
            Then: what recorded history holds for the start of the window, or the live objects already known then when
            there is no history. Now: what is here now.
          </p>
        </Section>
      ) : null}
      {rows && rows.status.length ? (
        <Section title={`Status changes (${rows.status.length})`}>
          <ul className="wv-changes__list">
            {rows.status.slice(0, CHANGES_LIST_LIMIT).map((s) => (
              <li key={`${s.objectId}:${s.at}`}>
                <button
                  type="button"
                  className="wv-changes__row"
                  disabled={s.objectId.startsWith('source:')}
                  onClick={() => void actions.select(s.objectId, { kind: 'object', fly: true })}
                >
                  <span className="wv-changes__title wv-truncate">{s.name}</span>
                  <span className="wv-changes__type">
                    {s.from || '—'} → {s.to || '—'}
                  </span>
                  <span className="wv-changes__age wv-num">{formatAgo(s.at, nowMs)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </Panel>
  );
}
