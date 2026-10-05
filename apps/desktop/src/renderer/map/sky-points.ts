import { useEffect, useRef } from 'react';
import type { RenderFeature } from '@worldview/render-core';
import { moonIllumination, subsolarPoint, sublunarPoint } from '@worldview/world-model';
import { useNow } from '../hooks/use-now.js';
import type { RendererHostLike } from '../renderer-host-like.js';
import { NO_TOOL_LAYER, sendToolLayer, type ToolLayerShown } from './tool-layers.js';

/**
 * With day and night on (N), the two points it turns on: where the Sun stands overhead — the
 * middle of the day side — and where the Moon does, named with how much of it is lit. A layer
 * of their own beside the presentation pass (tool-layers.ts), never pick targets, moved once a
 * minute with the shading.
 */
export const SKY_POINTS_LAYER = 'sky-points';

export function skyPointFeatures(nowMs: number): RenderFeature[] {
  const sun = subsolarPoint(nowMs);
  const moon = sublunarPoint(nowMs);
  const lit = Math.round(moonIllumination(nowMs).fraction * 100);
  return [
    {
      id: 'sky:sun',
      geometry: { kind: 'point', position: { latitude: sun.latitude, longitude: sun.longitude } },
      style: { styleClass: 'sky.sun', size: 9, label: 'Sun overhead', labelPriority: 2 },
      interactive: false,
      priority: 2,
      layer: SKY_POINTS_LAYER,
    },
    {
      id: 'sky:moon',
      geometry: { kind: 'point', position: moon },
      style: { styleClass: 'sky.moon', size: 8, label: `Moon overhead · ${lit}% lit`, labelPriority: 2 },
      interactive: false,
      priority: 2,
      layer: SKY_POINTS_LAYER,
    },
  ];
}

/**
 * Sends the two points while `on`, and takes them away when not: for `atMs` when given (the
 * timeline's time, paused or replaying), else for now. Its own component, so the minute's tick
 * re-renders only this, not the map.
 */
export function SkyPoints({
  host,
  on,
  atMs,
}: {
  host: RendererHostLike | undefined;
  on: boolean;
  atMs?: number | undefined;
}): null {
  const nowMs = useNow(60_000);
  const shown = useRef<ToolLayerShown>(NO_TOOL_LAYER);
  const minute = Math.floor((atMs ?? nowMs) / 60_000);
  useEffect(() => {
    if (!host?.setFeatures) return;
    sendToolLayer(host, shown, on ? String(minute) : '', () => (on ? skyPointFeatures(minute * 60_000) : []));
  }, [host, on, minute]);
  return null;
}
