import { useId } from 'react';
import './toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
  /** Hide the visible label (still announced). */
  hideLabel?: boolean | undefined;
  size?: 'sm' | 'md' | undefined;
}

/** Switch control (role="switch"); Space/Enter toggles via the native button. */
export function Toggle({ checked, onChange, label, description, disabled, hideLabel, size = 'md' }: ToggleProps) {
  const id = useId();
  const descId = description ? `${id}-desc` : undefined;
  return (
    <div className={`wv-toggle wv-toggle--${size}${disabled ? ' wv-toggle--disabled' : ''}`}>
      <button
        type="button"
        role="switch"
        id={id}
        className="wv-toggle__track"
        aria-checked={checked}
        aria-label={hideLabel ? label : undefined}
        aria-labelledby={hideLabel ? undefined : `${id}-label`}
        aria-describedby={descId}
        disabled={disabled ?? false}
        onClick={() => onChange(!checked)}
      >
        <span className="wv-toggle__thumb" />
      </button>
      {hideLabel ? null : (
        <div className="wv-toggle__text">
          <label id={`${id}-label`} htmlFor={id} className="wv-toggle__label">
            {label}
          </label>
          {description ? (
            <span id={descId} className="wv-toggle__desc">
              {description}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
