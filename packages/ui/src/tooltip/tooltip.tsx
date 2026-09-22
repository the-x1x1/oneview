import { useId, useState, type ReactNode } from 'react';
import './tooltip.css';

export interface TooltipProps {
  text: string;
  children: ReactNode;
  placement?: 'top' | 'bottom' | undefined;
  className?: string | undefined;
}

/**
 * Hover/focus tooltip. The tooltip text is always in the DOM (role=tooltip, linked via
 * aria-describedby) so it is available to assistive technology; visibility is CSS-driven
 * plus a state flag for keyboard focus.
 */
export function Tooltip({ text, children, placement = 'top', className }: TooltipProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <span
      className={`wv-tooltip${visible ? ' wv-tooltip--visible' : ''}${className ? ` ${className}` : ''}`}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
      aria-describedby={id}
    >
      {children}
      <span id={id} role="tooltip" className={`wv-tooltip__bubble wv-tooltip__bubble--${placement}`}>
        {text}
      </span>
    </span>
  );
}
