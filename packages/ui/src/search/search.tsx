import { forwardRef, useId, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../icon/icon.js';
import type { IconName } from '../icon/glyphs.js';
import { moveActiveIndex } from '../virtual-list/virtual-math.js';
import './search.css';

export interface SearchResultItem {
  id: string;
  title: string;
  subtitle?: string | undefined;
  icon?: IconName | undefined;
  /** Small right-aligned hint (e.g. kind or shortcut). */
  hint?: string | undefined;
}

export interface SearchProps {
  value: string;
  onChange: (value: string) => void;
  results: ReadonlyArray<SearchResultItem>;
  onPick: (result: SearchResultItem) => void;
  placeholder?: string | undefined;
  /** Accessible name of the input. */
  label: string;
  /** Shown while results are being fetched. */
  busy?: boolean | undefined;
  /** Shown below the results (e.g. "Searching local index only — offline"). */
  footer?: ReactNode | undefined;
  onEscape?: (() => void) | undefined;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
  /** Render results inline (palette) instead of as a floating popup. */
  inline?: boolean | undefined;
  /** Text shown when the query is non-empty and there are no results. */
  emptyText?: string | undefined;
}

/** Combobox (input + listbox) with arrow-key navigation, Enter to pick and Esc to close. */
export const Search = forwardRef<HTMLInputElement, SearchProps>(function Search(
  {
    value,
    onChange,
    results,
    onPick,
    placeholder = 'Search places, objects, events',
    label,
    busy,
    footer,
    onEscape,
    autoFocus,
    className,
    inline,
    emptyText = 'No matches',
  },
  ref,
) {
  const id = useId();
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const showList = inline || (open && value.length > 0);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      onEscape?.();
      return;
    }
    if (e.key === 'Enter') {
      const pick = results[active >= 0 ? active : 0];
      if (pick) {
        e.preventDefault();
        onPick(pick);
        setOpen(false);
      }
      return;
    }
    const next = moveActiveIndex(active, results.length, e.key);
    if (next !== active) {
      e.preventDefault();
      setActive(next);
    }
  };

  return (
    <div className={`wv-search${inline ? ' wv-search--inline' : ''}${className ? ` ${className}` : ''}`}>
      <div className="wv-search__field">
        <Icon name="search" size={15} className="wv-search__icon" />
        <input
          ref={ref}
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded={showList}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && showList ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="wv-search__input"
          placeholder={placeholder}
          value={value}
          autoFocus={autoFocus ?? false}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            onChange(e.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            if (!inline) setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={onKeyDown}
        />
        {value ? (
          <button
            type="button"
            className="wv-search__clear"
            aria-label="Clear search"
            onClick={() => {
              onChange('');
              setActive(-1);
            }}
          >
            <Icon name="close" size={13} />
          </button>
        ) : null}
      </div>
      {showList ? (
        <div className="wv-search__popup">
          <ul id={`${id}-list`} role="listbox" aria-label={`${label} results`} className="wv-search__list">
            {results.map((r, i) => (
              <li
                key={r.id}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={`wv-search__item${i === active ? ' wv-search__item--active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(r);
                  setOpen(false);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {r.icon ? <Icon name={r.icon} size={15} className="wv-search__item-icon" /> : null}
                <span className="wv-search__item-text">
                  <span className="wv-search__item-title wv-truncate">{r.title}</span>
                  {r.subtitle ? <span className="wv-search__item-subtitle wv-truncate">{r.subtitle}</span> : null}
                </span>
                {r.hint ? <span className="wv-search__item-hint">{r.hint}</span> : null}
              </li>
            ))}
            {results.length === 0 && value && !busy ? (
              <li className="wv-search__empty" role="presentation">
                {emptyText}
              </li>
            ) : null}
            {busy ? (
              <li className="wv-search__empty" role="presentation" aria-live="polite">
                Searching
              </li>
            ) : null}
          </ul>
          {footer ? <div className="wv-search__footer">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  );
});
