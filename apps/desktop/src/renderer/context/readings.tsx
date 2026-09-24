import { useEffect, useMemo, useState } from 'react';
import type { WorldObject } from '@worldview/world-model';
import type { WorldClient } from '@worldview/ipc-contract';
import {
  readings,
  resolveTelemetry,
  withLatest,
  type HistoryQuery,
  type ReadingPoint,
  type ReadingWindow,
  type ResolvedTelemetry,
  type TelemetryDescriptor,
} from '@worldview/telemetry';
import { useActions, useAppState, useClient } from '../store/store.js';
import { contextRegistry, type ContextSection, type ContextSectionProps } from './registry.js';
import { READING_WINDOWS, ReadingsView } from './readings-view.js';

/** Instants sampled across a window (package default); a 1 h window reads one per minute. */
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

/** `history.query` through the client — the one request the projection needs. */
export function historyQuery(client: WorldClient): HistoryQuery {
  return (query) => client.request('history.query', query);
}

/** What resolves for an object before its sources' manifests are read (defaults and discovery). */
export function baseTelemetry(object: WorldObject): ResolvedTelemetry | undefined {
  return resolveTelemetry({ objectType: object.type, properties: object.properties });
}

interface LoadState {
  key: string;
  series?: Map<string, ReadingPoint[]>;
  stepMs?: number;
  failed?: number;
  error?: string;
}

/**
 * The Readings section: the object's readings over a window that follows the timeline.
 * Series come from its sources' descriptors (read through `sources.manifest`), else its
 * type's defaults; values come from history, plus the object's own latest values.
 */
export function Readings({ object, nowMs }: Pick<ContextSectionProps, 'object' | 'nowMs'>) {
  const { sources, timeline } = useAppState();
  const actions = useActions();
  const client = useClient();
  const [windowMs, setWindowMs] = useState(READING_WINDOWS[0]!.ms);
  const providers = useMemo(() => objectProviders(object), [object]);

  // The sources' descriptors live on their manifests; ask for the ones not loaded yet.
  useEffect(() => {
    for (const id of providers) if (!(id in sources.manifests)) void actions.loadManifest(id);
  }, [providers, sources.manifests, actions]);
  const descriptors: Array<TelemetryDescriptor | undefined> = providers.map((id) => sources.manifests[id]?.telemetry);
  const resolved = resolveTelemetry({
    objectType: object.type,
    properties: object.properties,
    sourceDescriptors: descriptors,
  });

  const live = timeline.control.mode === 'LIVE';
  const cursorMs = live ? nowMs : timeline.control.cursorMs;
  const window = readingsWindow(cursorMs, windowMs);
  const keys = resolved?.series.map((s) => s.key) ?? [];
  const keyList = keys.join('|');
  const loadKey = `${object.id}|${window.startMs}|${window.endMs}|${keyList}`;
  const [load, setLoad] = useState<LoadState>({ key: '' });

  const { id: objectId, type: objectType, position } = object;
  const latitude = position?.latitude;
  const longitude = position?.longitude;
  const providerList = providers.join('|');
  const { startMs, endMs } = window;
  useEffect(() => {
    if (!keyList) return;
    const controller = new AbortController();
    const target = {
      objectId,
      objectType,
      providerIds: providerList.split('|'),
      ...(latitude !== undefined && longitude !== undefined ? { position: { latitude, longitude } } : {}),
    };
    const key = `${objectId}|${startMs}|${endMs}|${keyList}`;
    readings(
      historyQuery(client),
      target,
      keyList.split('|'),
      { startMs, endMs },
      {
        samples: SAMPLES,
        signal: controller.signal,
      },
    )
      .then((r) => setLoad({ key, series: r.series, stepMs: r.stepMs, failed: r.failed }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setLoad({ key, error: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, [client, objectId, objectType, providerList, latitude, longitude, keyList, startMs, endMs]);

  if (!resolved) return null;
  const current = load.key === loadKey ? load : undefined;
  const base = current?.series ?? new Map<string, ReadingPoint[]>(keys.map((k) => [k, []]));
  // The live object keeps reporting after history was read; in replay it is the world at the cursor.
  const data = withLatest(base, object, window);

  return (
    <ReadingsView
      series={resolved.series}
      data={data}
      window={window}
      cursorMs={cursorMs}
      windowMs={windowMs}
      onWindow={setWindowMs}
      onSeek={(ms) => actions.seekTo(ms)}
      origin={resolved.origin}
      loading={!current}
      {...(current?.stepMs !== undefined ? { stepMs: current.stepMs } : {})}
      {...(current?.failed ? { failed: current.failed } : {})}
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
