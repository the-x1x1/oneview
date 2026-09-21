import { createRoot } from 'react-dom/client';
import type { WorldClient } from '@worldview/ipc-contract';
import { createShell } from './create-shell.js';
import { createCanvasHost } from './demo/canvas-host.js';
import { createDemoClient } from './demo/demo-client.js';
import type { RendererHostLike } from './renderer-host-like.js';

/**
 * Composition root.
 *  - Electron: the preload exposes `window.worldview` (WorldBridge). The desktop-platform
 *    workstream installs the production RendererHost on `window.worldviewHost` before this
 *    module runs (or the lead replaces `resolveHost`); until then the canvas host is used
 *    so the shell stays usable and honest about being 2D-only.
 *  - Browser dev/demo (`pnpm --filter @worldview/desktop dev:browser`): an in-process
 *    DemoClient serves recorded fixtures and the canvas host renders them.
 */
declare global {
  interface Window { worldviewHost?: RendererHostLike }
}

function browserDownload(name: string, mimeType: string, bytes: Uint8Array): string | null {
  try {
    const copy = new Uint8Array(bytes.byteLength); copy.set(bytes); // detach from any shared buffer
    const url = URL.createObjectURL(new Blob([copy], { type: mimeType }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return `Downloads/${name}`;
  } catch { return null; }
}

function resolveClient(): { client: WorldClient; demo: boolean } {
  if (window.worldview) return { client: window.worldview, demo: false };
  const client = createDemoClient({
    autoTick: true,
    openExternal: (url) => { const w = window.open(url, '_blank', 'noopener,noreferrer'); return !!w; },
    download: browserDownload,
  });
  return { client, demo: true };
}

function resolveHost(): RendererHostLike {
  return window.worldviewHost ?? createCanvasHost();
}

const container = document.getElementById('root');
if (!container) throw new Error('renderer: #root element is missing');
const { client } = resolveClient();
createRoot(container).render(createShell({ client, host: resolveHost() }));
