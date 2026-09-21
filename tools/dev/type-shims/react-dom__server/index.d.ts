/**
 * Declaration SHIM for `react-dom/server` — active only when `@types/react-dom`
 * is not installed. Declares only what WORLDVIEW's DOM-free render tests use.
 */
import type { ReactNode } from 'react';

export function renderToStaticMarkup(node: ReactNode, options?: { identifierPrefix?: string | undefined }): string;
export function renderToString(node: ReactNode, options?: { identifierPrefix?: string | undefined }): string;
