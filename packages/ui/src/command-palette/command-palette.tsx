import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, type SearchResultItem } from '../search/search.js';
import type { IconName } from '../icon/glyphs.js';
import { rank, type Rankable } from './ranking.js';
import './command-palette.css';

export interface PaletteCommand extends Rankable {
  id: string;
  title: string;
  /** Group heading (e.g. "Navigate", "View", "Sources"). */
  group?: string | undefined;
  icon?: IconName | undefined;
  shortcut?: string | undefined;
  keywords?: ReadonlyArray<string> | undefined;
  /** Commands that cannot run right now are omitted from the list — never shown disabled as decoration. */
  available?: boolean | undefined;
  run: () => void | Promise<void>;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: ReadonlyArray<PaletteCommand>;
  /**
   * Optional async provider of non-command results (places/objects) for the current query.
   * Results are shown after the matching commands.
   */
  searchResults?: ReadonlyArray<SearchResultItem> | undefined;
  onSearch?: ((query: string) => void) | undefined;
  onPickSearchResult?: ((result: SearchResultItem) => void) | undefined;
  busy?: boolean | undefined;
  footer?: ReactNode | undefined;
}

/** Command → search item mapping; exported so the shell can test ranking glue without rendering. */
export function paletteItems(
  query: string,
  commands: ReadonlyArray<PaletteCommand>,
  searchResults: ReadonlyArray<SearchResultItem> = [],
): SearchResultItem[] {
  const available = commands.filter((c) => c.available !== false);
  const ranked = rank(query, available, query ? 8 : 12).map(({ item }) => ({
    id: `cmd:${item.id}`,
    title: item.title,
    ...(item.group ? { subtitle: item.group } : {}),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.shortcut ? { hint: item.shortcut } : {}),
  }));
  return [...ranked, ...searchResults.map((r) => ({ ...r, id: r.id.startsWith('cmd:') ? `res:${r.id}` : r.id }))];
}

export function CommandPalette({
  open,
  onClose,
  commands,
  searchResults,
  onSearch,
  onPickSearchResult,
  busy,
  footer,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      inputRef.current?.focus();
    }
  }, [open]);

  const items = useMemo(() => paletteItems(query, commands, searchResults ?? []), [query, commands, searchResults]);

  if (!open) return null;

  const pick = (r: SearchResultItem) => {
    if (r.id.startsWith('cmd:')) {
      const cmd = commands.find((c) => `cmd:${c.id}` === r.id);
      onClose();
      void cmd?.run();
      return;
    }
    onClose();
    onPickSearchResult?.(r);
  };

  return (
    <div
      className="wv-palette__overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="wv-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <Search
          ref={inputRef}
          inline
          autoFocus
          label="Command or search"
          placeholder="Type a command, place, object or event"
          value={query}
          onChange={(v) => {
            setQuery(v);
            onSearch?.(v);
          }}
          results={items}
          onPick={pick}
          onEscape={onClose}
          busy={busy}
          emptyText="No commands or results match"
          footer={
            footer ?? (
              <span>
                <kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> run · <kbd>Esc</kbd> close
              </span>
            )
          }
        />
      </div>
    </div>
  );
}
