import { createRoot } from 'react-dom/client';
import type { WorldClient } from '@worldview/ipc-contract';
import { createShell } from './create-shell.js';
import { createCanvasHost } from './demo/canvas-host.js';
import { createDemoClient } from './demo/demo-client.js';
import { DesktopRendererHost } from './renderer-host.js';
import type { RendererHostLike } from './renderer-host-like.js';

/**
 * Composition root.
 *  - Electron: the preload exposes `window.worldview` (WorldBridge), and the map is the
 *    real thing — MapLibre in 2D, Cesium in 3D, behind DesktopRendererHost. Both are
 *    imported lazily, so a session that never leaves 2D never constructs a Cesium viewer
 *    or pays for its WebGL context.
 *  - Browser dev/demo (`pnpm --filter @worldview/desktop dev:browser`): an in-process
 *    DemoClient serves recorded fixtures and a plain-canvas host renders them, which is
 *    what lets the shell run with no GPU and no map libraries at all.
 *
 * `window.worldviewHost` remains an override for a host supplied from outside; it is no
 * longer what production depends on. It used to be the only path, and nothing ever set
 * it, so every build fell through to the demo canvas host — including packaged ones.
 */
declare global {
  interface Window {
    worldviewHost?: RendererHostLike;
  }
}

function browserDownload(name: string, mimeType: string, bytes: Uint8Array): string | null {
  try {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes); // detach from any shared buffer
    const url = URL.createObjectURL(new Blob([copy], { type: mimeType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return `Downloads/${name}`;
  } catch {
    return null;
  }
}

function resolveClient(): { client: WorldClient; demo: boolean } {
  if (window.worldview) return { client: window.worldview, demo: false };
  const client = createDemoClient({
    autoTick: true,
    openExternal: (url) => {
      const w = window.open(url, '_blank', 'noopener,noreferrer');
      return !!w;
    },
    download: browserDownload,
  });
  return { client, demo: true };
}

/** WebGL2 decides whether the globe is offered at all; AUTO resolves against it. */
function detectCapabilities(): { webgl2: boolean; lowPower: boolean } {
  let webgl2 = false;
  try {
    const probe = document.createElement('canvas');
    webgl2 = probe.getContext('webgl2') !== null;
  } catch {
    webgl2 = false;
  }
  const lowPower =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number' &&
    navigator.hardwareConcurrency <= 4;
  return { webgl2, lowPower };
}

function resolveHost(electron: boolean): RendererHostLike {
  if (window.worldviewHost) return window.worldviewHost;
  if (!electron) return createCanvasHost();

  const caps = detectCapabilities();
  return new DesktopRendererHost({
    capabilities: { webgl2: caps.webgl2, lowPower: caps.lowPower },
    create2D: async () => {
      const [{ MapLibreWorldRenderer }, { loadMapLibre }] = await Promise.all([
        import('@worldview/render-maplibre'),
        import('@worldview/render-maplibre'),
      ]);
      const { maplibre, pmtiles } = await loadMapLibre();
      return new MapLibreWorldRenderer({ maplibre, pmtiles });
    },
    create3D: async () => {
      const [{ CesiumWorldRenderer }, { loadCesium }] = await Promise.all([
        import('@worldview/render-cesium'),
        import('@worldview/render-cesium'),
      ]);
      const cesium = await loadCesium();
      return new CesiumWorldRenderer({ cesium });
    },
    onError: (error) => {
      console.error('[renderer] %s%s', error.message, error.fatal ? ' (fatal)' : '');
    },
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('renderer: #root element is missing');
const { client, demo } = resolveClient();
createRoot(container).render(createShell({ client, host: resolveHost(!demo) }));
