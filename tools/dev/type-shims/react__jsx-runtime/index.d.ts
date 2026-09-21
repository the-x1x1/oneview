/**
 * Declaration SHIM for `react/jsx-runtime` (automatic JSX runtime) — active only
 * when `@types/react` is not installed. See ../react/index.d.ts.
 */
import type { Key, ReactElement, ReactNode } from 'react';

export { Fragment, JSX } from 'react';

export function jsx(type: unknown, props: Record<string, unknown> & { children?: ReactNode }, key?: Key): ReactElement;
export function jsxs(type: unknown, props: Record<string, unknown> & { children?: ReactNode }, key?: Key): ReactElement;
