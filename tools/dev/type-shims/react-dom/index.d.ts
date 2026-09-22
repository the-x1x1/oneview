/**
 * Declaration SHIM for `react-dom` — active only when `@types/react-dom` is not
 * installed. Declares only what WORLDVIEW uses.
 */
import type { ReactNode } from 'react';

export function createPortal(
  children: ReactNode,
  container: Element | DocumentFragment,
  key?: string | null,
): ReactNode;
export function flushSync<R>(fn: () => R): R;
export const version: string;
