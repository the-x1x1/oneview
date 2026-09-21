import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { IconButton } from '../button/button.js';
import './dialog.css';

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode | undefined;
  /** Footer actions (buttons). */
  footer?: ReactNode | undefined;
  size?: 'sm' | 'md' | 'lg' | undefined;
  /** Description for screen readers / subtitle. */
  description?: string | undefined;
  /** When false the dialog cannot be dismissed with Esc/overlay click (e.g. first-run — still has explicit buttons). */
  dismissible?: boolean | undefined;
  className?: string | undefined;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: role=dialog, aria-modal, focus moves in on open and is trapped, Esc closes, focus restored on close. */
export function Dialog({ open, title, onClose, children, footer, size = 'md', description, dismissible = true, className }: DialogProps) {
  const id = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => {
      const el = restoreRef.current;
      if (el && el instanceof HTMLElement) el.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && dismissible) { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab' || !ref.current) return;
    const nodes = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0]!, last = nodes[nodes.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="wv-dialog__overlay" onMouseDown={(e) => { if (dismissible && e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        className={`wv-dialog wv-dialog--${size}${className ? ` ${className}` : ''}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="wv-dialog__header">
          <div>
            <h2 id={`${id}-title`} className="wv-dialog__title">{title}</h2>
            {description ? <p id={`${id}-desc`} className="wv-dialog__desc">{description}</p> : null}
          </div>
          {dismissible ? <IconButton icon="close" label="Close" onClick={onClose} /> : null}
        </header>
        <div className="wv-dialog__body">{children}</div>
        {footer ? <footer className="wv-dialog__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
