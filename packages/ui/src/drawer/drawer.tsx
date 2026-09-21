import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconButton } from '../button/button.js';
import './drawer.css';

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  side?: 'left' | 'right' | 'bottom' | undefined;
  children?: ReactNode | undefined;
  /** Width (left/right) or height (bottom) in px. */
  size?: number | undefined;
  className?: string | undefined;
}

/** Non-modal side sheet (role=complementary) — Esc closes when focus is inside. */
export function Drawer({ open, title, onClose, side = 'right', children, size, className }: DrawerProps) {
  const id = useId();
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
  }, [open]);

  if (!open) return null;
  const style = size !== undefined ? (side === 'bottom' ? { height: `${size}px` } : { width: `${size}px` }) : undefined;
  return (
    <aside
      ref={ref}
      className={`wv-drawer wv-drawer--${side}${className ? ` ${className}` : ''}`}
      style={style}
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <header className="wv-drawer__header">
        <h2 id={`${id}-title`} className="wv-drawer__title">{title}</h2>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </header>
      <div className="wv-drawer__body">{children}</div>
    </aside>
  );
}
