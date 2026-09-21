import type { ReactNode } from 'react';
import { Icon } from '../icon/icon.js';
import type { IconName } from '../icon/glyphs.js';
import { Button } from '../button/button.js';
import './states.css';

export interface EmptyStateProps {
  title: string;
  /** Explain honestly why there is nothing (e.g. "No history is available for aircraft"). */
  description?: string | undefined;
  icon?: IconName | undefined;
  action?: { label: string; onClick: () => void } | undefined;
  compact?: boolean | undefined;
}

export function EmptyState({ title, description, icon = 'info', action, compact }: EmptyStateProps) {
  return (
    <div className={`wv-state wv-state--empty${compact ? ' wv-state--compact' : ''}`} role="status">
      <Icon name={icon} size={compact ? 18 : 24} className="wv-state__icon" />
      <p className="wv-state__title">{title}</p>
      {description ? <p className="wv-state__desc">{description}</p> : null}
      {action ? <Button size="sm" onClick={action.onClick}>{action.label}</Button> : null}
    </div>
  );
}

export interface ErrorStateProps {
  title: string;
  /** Sanitized message — never a stack trace or a secret. */
  message?: string | undefined;
  retry?: { label?: string | undefined; onClick: () => void } | undefined;
  compact?: boolean | undefined;
  children?: ReactNode | undefined;
}

export function ErrorState({ title, message, retry, compact, children }: ErrorStateProps) {
  return (
    <div className={`wv-state wv-state--error${compact ? ' wv-state--compact' : ''}`} role="alert">
      <Icon name="error" size={compact ? 18 : 24} className="wv-state__icon" />
      <p className="wv-state__title">{title}</p>
      {message ? <p className="wv-state__desc">{message}</p> : null}
      {children}
      {retry ? <Button size="sm" icon="refresh" onClick={retry.onClick}>{retry.label ?? 'Retry'}</Button> : null}
    </div>
  );
}

export interface LoadingStateProps {
  label?: string | undefined;
  compact?: boolean | undefined;
}

/** Determinate-less loading indicator: a quiet bar, no spinners or blinking. */
export function LoadingState({ label = 'Loading', compact }: LoadingStateProps) {
  return (
    <div className={`wv-state wv-state--loading${compact ? ' wv-state--compact' : ''}`} role="status" aria-live="polite" aria-busy="true">
      <span className="wv-state__bar" aria-hidden="true"><span className="wv-state__bar-fill" /></span>
      <p className="wv-state__desc">{label}</p>
    </div>
  );
}
