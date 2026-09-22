import { GLYPHS, type IconName } from './glyphs.js';
import './icon.css';

export interface IconProps {
  name: IconName;
  /** Pixel size (defaults to 16). Scales with text when `size` is omitted via CSS em. */
  size?: number | undefined;
  /** Accessible label. When omitted the icon is decorative (aria-hidden). */
  label?: string | undefined;
  className?: string | undefined;
  /** Filled glyphs (play, pause, bookmark) render with fill instead of stroke. */
  filled?: boolean | undefined;
}

const FILLED: ReadonlySet<IconName> = new Set(['play', 'pause', 'skipEnd', 'aircraft']);

export function Icon({ name, size, label, className, filled }: IconProps) {
  const paths = GLYPHS[name];
  const isFilled = filled ?? FILLED.has(name);
  const cls = `wv-icon${isFilled ? ' wv-icon--filled' : ''}${className ? ` ${className}` : ''}`;
  const dim = size ?? 16;
  return (
    <svg
      className={cls}
      width={dim}
      height={dim}
      viewBox="0 0 24 24"
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      data-icon={name}
    >
      {label ? <title>{label}</title> : null}
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
