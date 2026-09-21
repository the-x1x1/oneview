import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './popover.css';

export interface PopoverProps {
  /** The element that opens the popover; receives aria attributes through `renderTrigger`. */
  renderTrigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-controls': string; 'aria-haspopup': 'dialog' }) => ReactNode;
  children: ReactNode;
  /** Accessible name of the popover surface. */
  label: string;
  align?: 'start' | 'end' | undefined;
  placement?: 'bottom' | 'top' | undefined;
  /** Controlled open state (optional). */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  className?: string | undefined;
}

/** Anchored non-modal surface. Closes on Esc, outside pointer-down, or focus leaving. */
export function Popover({ renderTrigger, children, label, align = 'start', placement = 'bottom', open, onOpenChange, className }: PopoverProps) {
  const id = useId();
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = (v: boolean) => { setInternalOpen(v); onOpenChange?.(v); };
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;
    const onDown = (e: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  return (
    <div ref={rootRef} className={`wv-popover${className ? ` ${className}` : ''}`}>
      {renderTrigger({ onClick: () => setOpen(!isOpen), 'aria-expanded': isOpen, 'aria-controls': id, 'aria-haspopup': 'dialog' })}
      {isOpen ? (
        <div id={id} role="dialog" aria-label={label} className={`wv-popover__surface wv-popover__surface--${placement} wv-popover__surface--${align}`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
