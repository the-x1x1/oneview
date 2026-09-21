/**
 * Declaration SHIM for `react-dom/client` — active only when `@types/react-dom`
 * is not installed. Declares only what WORLDVIEW uses.
 */
import type { ReactNode } from 'react';

export interface Root {
  render(children: ReactNode): void;
  unmount(): void;
}

export interface RootOptions {
  identifierPrefix?: string | undefined;
  onUncaughtError?: ((error: unknown, errorInfo: { componentStack?: string | undefined }) => void) | undefined;
  onCaughtError?: ((error: unknown, errorInfo: { componentStack?: string | undefined }) => void) | undefined;
}

export function createRoot(container: Element | DocumentFragment, options?: RootOptions): Root;
