import { useEffect, useState } from 'react';
import type { JsonValue, WorldObject } from '@worldview/world-model';
import type { WorldObjectDetails } from '@worldview/ipc-contract';
import { Button, FieldList } from '@worldview/ui';
import type { ShellActions } from '../store/actions.js';
import { noPassesText, passObserverText, passViews, satcatRows, satcatStatusNote } from './object-knowledge.js';

/**
 * The part of a satellite's Orbit section that is asked for when it is selected
 * (`world.details`): its CelesTrak SATCAT record and its next passes over the ground in the
 * middle of the view. Fetched once per selection, keyed on the object's id — not on the object,
 * which changes with every 15-second propagation — and again when the operator asks for passes
 * over where the view now is, or when the first listed pass is over.
 */
type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; properties: Record<string, JsonValue>; attributions: string[] };

/** Longest wait before asking again on its own (a pass hours away still gets a fresh answer). */
const MAX_REFRESH_MS = 6 * 3600_000;

export function mergeDetails(details: readonly WorldObjectDetails[]): {
  properties: Record<string, JsonValue>;
  attributions: string[];
} {
  const properties: Record<string, JsonValue> = {};
  const attributions: string[] = [];
  for (const d of details) {
    Object.assign(properties, d.properties);
    const line = d.attribution ?? d.label;
    if (line && !attributions.includes(line)) attributions.push(line);
  }
  return { properties, attributions };
}

/** When the first pass still to come ends (ms), so the list can be recomputed then. */
export function firstPassEnd(properties: Readonly<Record<string, JsonValue>>, nowMs: number): number | undefined {
  const passes = properties['passes'];
  if (!Array.isArray(passes)) return undefined;
  for (const p of passes) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const set = (p as Record<string, JsonValue>)['setAt'];
    const t = typeof set === 'string' ? Date.parse(set) : Number.NaN;
    if (Number.isFinite(t) && t > nowMs) return t;
  }
  return undefined;
}

export function SatelliteKnowledge({
  object,
  actions,
  nowMs,
}: {
  object: WorldObject;
  actions: ShellActions;
  nowMs: number;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [round, setRound] = useState(0);
  const id = object.id;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void actions.objectDetails(id).then((answer) => {
      if (cancelled) return;
      setState(answer ? { status: 'ready', ...mergeDetails(answer.details) } : { status: 'failed' });
    });
    return () => {
      cancelled = true;
    };
  }, [id, actions, round]);

  // Ask again when the first pass listed is over, so the list stays three passes ahead.
  const end = state.status === 'ready' ? firstPassEnd(state.properties, Date.now()) : undefined;
  useEffect(() => {
    if (end === undefined) return undefined;
    const timer = setTimeout(() => setRound((n) => n + 1), Math.min(MAX_REFRESH_MS, end - Date.now() + 5_000));
    return () => clearTimeout(timer);
  }, [end]);

  if (state.status === 'loading')
    return <p className="wv-ctx-muted">Reading the catalogue record and working out passes…</p>;
  if (state.status === 'failed')
    return (
      <div className="wv-ctx-stack">
        <p className="wv-ctx-muted">The catalogue record and passes could not be fetched.</p>
        <Button size="sm" icon="refresh" onClick={() => setRound((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );

  const p = state.properties;
  const passes = passViews(p, nowMs);
  const none = noPassesText(p);
  const note = satcatStatusNote(p);
  const observer = passObserverText(p);
  return (
    <div className="wv-ctx-stack">
      <FieldList rows={satcatRows(p)} />
      {note ? <p className="wv-ctx-muted">{note}</p> : null}
      {passes !== undefined || none ? (
        <div className="wv-ctx-stack" aria-label="Next passes">
          <h4 className="wv-ctx-subhead wv-caps">Next passes</h4>
          {observer ? <p className="wv-ctx-muted">{observer}</p> : null}
          {passes?.length ? (
            <ol className="wv-ctx-passes">
              {passes.map((v) => (
                <li key={v.when} className="wv-ctx-pass">
                  <span className="wv-num">{v.when}</span>
                  <span className="wv-ctx-muted">
                    {v.peak}
                    {v.duration ? ` · ${v.duration}` : ''} · {v.path}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {none ? <p className="wv-ctx-muted">{none}</p> : null}
          {typeof p['passElementsEpoch'] === 'string' ? (
            <p className="wv-ctx-muted">
              Predicted with SGP4 from the element set of {String(p['passElementsEpoch']).slice(0, 10)}: good to seconds
              when the elements are fresh, drifting by minutes as they age.
            </p>
          ) : null}
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => setRound((n) => n + 1)}>
            Passes over the middle of the view now
          </Button>
        </div>
      ) : null}
      {state.attributions.map((a) => (
        <p key={a} className="wv-ctx-muted">
          {a}
        </p>
      ))}
    </div>
  );
}
