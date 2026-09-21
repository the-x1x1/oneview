import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from '../icon/icon.js';
import type { IconName } from '../icon/glyphs.js';
import './button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  icon?: IconName | undefined;
  /** Submit buttons must opt in; default is a plain button so forms never submit by accident. */
  type?: 'button' | 'submit' | undefined;
  /** Renders a pressed state (aria-pressed) for toggle-like buttons. */
  pressed?: boolean | undefined;
  children?: ReactNode | undefined;
}

export function Button({ variant = 'secondary', size = 'md', icon, type = 'button', pressed, className, children, ...rest }: ButtonProps) {
  const cls = ['wv-btn', `wv-btn--${variant}`, `wv-btn--${size}`, pressed ? 'wv-btn--pressed' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})} {...rest}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children !== undefined ? <span className="wv-btn__label">{children}</span> : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  icon: IconName;
  /** Required: icon-only buttons must have an accessible name. */
  label: string;
  size?: ButtonSize | undefined;
  variant?: 'ghost' | 'secondary' | undefined;
  pressed?: boolean | undefined;
  /** Optional filled/active accent state (e.g., active lens). */
  active?: boolean | undefined;
}

export function IconButton({ icon, label, size = 'md', variant = 'ghost', pressed, active, className, ...rest }: IconButtonProps) {
  const cls = ['wv-iconbtn', `wv-iconbtn--${variant}`, `wv-iconbtn--${size}`, active ? 'wv-iconbtn--active' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} aria-label={label} title={label} {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})} {...rest}>
      <Icon name={icon} size={size === 'sm' ? 14 : 18} />
    </button>
  );
}
