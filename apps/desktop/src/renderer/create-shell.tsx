import { StrictMode, type ReactNode } from 'react';
import type { WorldClient } from '@worldview/ipc-contract';
import { StoreProvider } from './store/store.js';
import { Shell } from './shell.js';
import type { RendererHostLike } from './renderer-host-like.js';
import type { RootState } from './store/types.js';
import '@worldview/ui/base.css';

export interface CreateShellOptions {
  /** The only runtime API the shell may use (preload bridge in Electron, DemoClient in the browser). */
  client: WorldClient;
  /** Renderer host to mount in the map area (RendererHost in Electron, canvas host in the demo). */
  host?: RendererHostLike | undefined;
  /** Pre-built state (static rendering / tests) — disables the runtime binding. */
  initialState?: RootState | undefined;
  now?: (() => number) | undefined;
}

/** Builds the shell element; `main.tsx` mounts it, tests render it to static markup. */
export function createShell({ client, host, initialState, now }: CreateShellOptions): ReactNode {
  return (
    <StrictMode>
      <StoreProvider client={client} host={host} initial={initialState} now={now}>
        <Shell />
      </StoreProvider>
    </StrictMode>
  );
}
