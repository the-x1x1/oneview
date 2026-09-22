import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { WorldClient } from '@worldview/ipc-contract';
import { initialState, rootReducer } from './reducer.js';
import type { RootAction, RootState } from './types.js';
import { createActions, type ShellActions } from './actions.js';
import { bindClient } from './sync.js';
import type { RendererHostLike } from '../renderer-host-like.js';

/**
 * Store = useReducer + context. Components read state with `useAppState()` and trigger
 * side effects through `useActions()` (typed wrappers around WorldClient requests that
 * dispatch results). `bindClient` subscribes to runtime events for the provider's lifetime.
 */
export interface HostRegistry {
  get(): RendererHostLike | null;
  set(host: RendererHostLike | null): void;
}

interface StoreContextValue {
  state: RootState;
  dispatch: Dispatch<RootAction>;
  actions: ShellActions;
  client: WorldClient;
  hosts: HostRegistry;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export interface StoreProviderProps {
  client: WorldClient;
  children?: ReactNode | undefined;
  /** Pre-built state for static rendering/tests; when given no runtime binding happens. */
  initial?: RootState | undefined;
  /** Injected clock for tests. */
  now?: (() => number) | undefined;
  /** Renderer host to expose to the map (the map component may also set one at mount). */
  host?: RendererHostLike | undefined;
}

export function StoreProvider({ client, children, initial, now, host }: StoreProviderProps) {
  const clock = now ?? Date.now;
  const [state, dispatch] = useReducer(rootReducer, undefined, () => {
    const base = initial ?? initialState(clock());
    const supports3D = host ? (host.supportsMode ? host.supportsMode('3D') : true) : base.ui.supports3D;
    return supports3D === base.ui.supports3D ? base : rootReducer(base, { type: 'ui/hostCapabilities', supports3D });
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const hostRef = useRef<RendererHostLike | null>(host ?? null);
  const hosts = useMemo<HostRegistry>(
    () => ({
      get: () => hostRef.current,
      set: (h) => {
        hostRef.current = h;
      },
    }),
    [],
  );
  const actions = useMemo(
    () => createActions({ client, dispatch, getState: () => stateRef.current, hosts, now: clock }),
    [client, hosts, clock],
  );

  useEffect(() => {
    if (initial) return;
    return bindClient({ client, dispatch, getState: () => stateRef.current, now: clock });
  }, [client, initial, clock]);

  const value = useMemo<StoreContextValue>(
    () => ({ state, dispatch, actions, client, hosts }),
    [state, actions, client, hosts],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

function useStoreContext(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('StoreProvider is missing above this component');
  return ctx;
}

export function useAppState(): RootState {
  return useStoreContext().state;
}
export function useDispatch(): Dispatch<RootAction> {
  return useStoreContext().dispatch;
}
export function useActions(): ShellActions {
  return useStoreContext().actions;
}
export function useClient(): WorldClient {
  return useStoreContext().client;
}
export function useHosts(): HostRegistry {
  return useStoreContext().hosts;
}
