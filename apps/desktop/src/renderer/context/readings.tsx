import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorldObject } from '@worldview/world-model';
import type { WorldClient } from '@worldview/ipc-contract';
import type { SourceHealthEntry } from '@worldview/source-health';
import {
  objectReadings,
  resolveTelemetry,
  withLatest,
  type HistoryReadings,
  type ReadingPoint,
  type ReadingWindow,
  type ResolvedTelemetry,
  type TelemetryDescriptor,
} from '@worldview/telemetry';
import { useActions, useAppState, useClient } from '../store/store.js';
import { contextRegistry, type ContextSection, type ContextSectionProps } from './registry.js';
import { READING_WINDOWS, ReadingsView } from './readings-view.js';

/** Slices across a window: the window moves (and history is read again) once a slice, a minute for 1 h. */
const SAMPLES = 60;

/** The providers an object came from, first-seen order (its `sourceRefs`, then its provenance). */
export function objectProviders(object: Pick<WorldObject, 'sourceRefs' | 'provenance'>): string[] {
  const ids: string[] = [];
  for (const ref of object.sourceRefs) if (!ids.includes(ref.providerId)) ids.push(ref.providerId);
  if (!ids.includes(object.provenance.providerId)) ids.push(object.provenance.providerId);
  return ids;
}

/**
 * The window the section reads: `lengthMs` ending at the timeline's cursor (now, when
 * live), the end rounded up to a whole slice so a moving cursor re-reads history once a
 * slice rather than on every tick.
 */
export function readingsWindow(endMs: number, lengthMs: number, samples = SAMPLES): ReadingWindow {
  const step = lengthMs / samples;
  const end = Math.ceil(endMs / step) * step;
  return { startMs: end - lengthMs, endMs: end };
}

/** `history.readings` through the client — the one request the section makes. */
export function historyReadings(client: WorldClient): HistoryReadings {
  return (request) => client.request('history.readings', request);
}

/** What resolves for an object before its sources' manifests are read (defaults and discovery). */
export function baseTelemetry(object: WorldObject): ResolvedTelemetry | undefined {
  return resolveTelemetry({ objectType: object.type, properties: object.properties });
}

interface LoadState {
  /** The object and keys the series belong to. */
  readKey: string;
  /** The window and cut-off they were read for. */
  key: string;
  series?: Map<string, ReadingPoint[]>;
  stepMs?: number;
  truncated?: boolean;
  error?: string;
}

/** Only the points inside `[startMs, untilMs]`: an earlier read drawn while the next one loads. */
function clip(series: ReadonlyMap<string, ReadonlyArray<ReadingPoint>>, startMs: number, untilMs: number) {
  const out = new Map<string, ReadingPoint[]>();
  for (const [key, points] of series)
    out.set(
      key,
      points.filter(([t]) => t >= startMs && t <= untilMs),
    );
  return out;
}

/**
 * The Readings section: the object's readings over a window that follows the timeline.
 * Series come from its sources' descriptors (read through `sources.manifest`), else its
 * type's defaults; values come from history, plus the live object's latest values.
 */
export function Readings({ object, nowMs }: Pick<ContextSectionProps, 'object' | 'nowMs'>) {
  const { sources, timeline } = useAppState();
  const actions = useActions();
  const client = useClient();
  const [windowMs, setWindowMs] = useState(READING_WINDOWS[0]!.ms);
  const providerList = objectProviders(object).join('|');
  const providers = useMemo(() => providerList.split('|'), [providerList]);

  // The sources' descriptors live on their manifests; ask once for each one not loaded yet.
  // A request that fails leaves nothing in the store, so the answer is also noted here.
  const asked = useRef(new Set<string>());
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    for (const id of providers)
      if (!(id in sources.manifests) && !asked.current.has(id)) {
        asked.current.add(id);
        void actions.loadManifest(id).finally(() => setAnswered((prev) => new Set(prev).add(id)));
      }
  }, [providers, sources.manifests, actions]);
  // Read history once every source's manifest has answered (or failed), so the series do
  // not change under a read already made.
  const settled = providers.every((id) => id in sources.manifests || answered.has(id));
  const descriptors: Array<TelemetryDescriptor | undefined> = providers.map((id) => sources.manifests[id]?.telemetry);
  const resolved = resolveTelemetry({
    objectType: object.type,
    properties: object.properties,
    sourceDescriptors: descriptors,
  });

  const live = timeline.control.mode === 'LIVE';
  const scrubbing = timeline.control.scrubbing;
  const cursorMs = live ? nowMs : timeline.control.cursorMs;
  const window = readingsWindow(cursorMs, windowMs);
  // Nothing after the moment on screen: the last slice ends at the cursor.
  const untilMs = Math.min(window.endMs, cursorMs);
  const keyList = resolved?.series.map((s) => s.key).join('|') ?? '';
  const objectId = object.id;
  // While live, the window's last slice is still being written: a new observation reads it
  // again. In replay nothing new lands, so the read follows the window alone.
  const fresh = live ? object.observedAt : '';
  const readKey = `${objectId}|${keyList}`;
  const loadKey = `${readKey}|${window.startMs}|${window.endMs}|${fresh}`;
  const [load, setLoad] = useState<LoadState>({ readKey: '', key: '' });

  const { startMs, endMs } = window;
  useEffect(() => {
    // While the cursor is dragged the last read stays on screen; the read follows the drop.
    if (!keyList || !settled || scrubbing) return;
    const controller = new AbortController();
    const rk = `${objectId}|${keyList}`;
    const key = `${rk}|${startMs}|${endMs}|${fresh}`;
    // One request for every reading in the window (telemetry R3). The window ends at the
    // cursor rounded up to a slice; what lies past the cursor is clipped below, never drawn.
    objectReadings(
      historyReadings(client),
      objectId,
      keyList.split('|'),
      { startMs, endMs },
      { samples: SAMPLES, signal: controller.signal },
    )
      .then((r) =>
        setLoad({ readKey: rk, key, series: r.series, stepMs: r.stepMs, ...(r.truncated ? { truncated: true } : {}) }),
      )
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setLoad({ readKey: rk, key, error: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, [client, objectId, keyList, settled, scrubbing, startMs, endMs, fresh]);

  if (!resolved) return null;
  // The last read for this object and these keys stays drawn, clipped to the new window,
  // until the next one arrives.
  const usable = load.readKey === readKey ? load : undefined;
  const current = usable && usable.key === loadKey ? usable : undefined;
  const empty = new Map<string, ReadingPoint[]>(resolved.series.map((s) => [s.key, []]));
  const base = usable?.series ? clip(usable.series, window.startMs, untilMs) : empty;
  // A live object keeps reporting after history was read. In replay the selected object may
  // still be the live one, whose values are after the cursor, so nothing is added there.
  const data = live ? withLatest(base, object, { startMs: window.startMs, endMs: untilMs }) : base;

  return (
    <ReadingsView
      series={resolved.series}
      data={data}
      window={window}
      cursorMs={cursorMs}
      windowMs={windowMs}
      onWindow={setWindowMs}
      onExport={() =>
        void actions.exportReadings(
          object.id,
          resolved.series.map((x) => x.key),
          new Date(window.startMs).toISOString(),
          new Date(untilMs).toISOString(),
        )
      }
      onSeek={(ms) => actions.seekTo(ms)}
      origin={resolved.origin}
      loading={!usable}
      {...(current?.stepMs !== undefined ? { stepMs: current.stepMs } : {})}
      {...(current?.truncated ? { truncated: true } : {})}
      {...(current?.error ? { error: current.error } : {})}
    />
  );
}

export const READINGS_SECTION_ID = 'readings';

/**
 * The section for a type, placed after `after`. It is left out when nothing resolves from
 * the object's own payload: a source's descriptor only ever names keys the payload carries,
 * and for these types every numeric key is already a reading, so nothing is missed.
 */
export function readingsSection(after: string): ContextSection {
  return {
    id: READINGS_SECTION_ID,
    title: 'Readings',
    placement: { after },
    render: ({ object, nowMs }) =>
      baseTelemetry(object) ? <Readings key={object.id} object={object} nowMs={nowMs} /> : null,
  };
}

/** Types the section is registered for (the brief: weather stations and sensors). */
export const READINGS_TYPES: ReadonlyArray<string> = ['weather-station', 'sensor'];

for (const type of READINGS_TYPES) contextRegistry.register(type, [readingsSection(type)]);

/**
 * Readings for an object of any other type whose source describes them (telemetry R2): a
 * tracker or an ingest source can carry a descriptor naming its battery or its speed. Decided
 * from the sources' descriptors as Source Health lists them (`meta.telemetry`), so the section
 * is left out — title and all — for every object whose sources describe nothing it carries.
 */
export function describedTelemetry(
  object: WorldObject,
  sources: ReadonlyArray<SourceHealthEntry>,
): ResolvedTelemetry | undefined {
  const providers = objectProviders(object);
  const descriptors = providers.map((id) => sources.find((s) => s.providerId === id)?.meta.telemetry);
  if (!descriptors.some(Boolean)) return undefined;
  const r = resolveTelemetry({
    objectType: object.type,
    properties: object.properties,
    sourceDescriptors: descriptors,
  });
  return r?.origin === 'source' ? r : undefined;
}

export const DESCRIBED_READINGS_SECTION_ID = 'readings-described';

export const describedReadingsSection: ContextSection = {
  id: DESCRIBED_READINGS_SECTION_ID,
  title: 'Readings',
  render: ({ object, nowMs, sources }) =>
    !READINGS_TYPES.includes(object.type) && describedTelemetry(object, sources) ? (
      <Readings key={object.id} object={object} nowMs={nowMs} />
    ) : null,
};

contextRegistry.register('*', [describedReadingsSection]);
