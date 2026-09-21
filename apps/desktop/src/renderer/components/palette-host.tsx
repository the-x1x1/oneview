import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchResult } from '@worldview/ipc-contract';
import { CommandPalette, type SearchResultItem } from '@worldview/ui';
import { buildCommands } from '../commands/commands.js';
import { applyKey, isEditableTarget, resolveKey } from '../commands/keyboard.js';
import { useActions, useAppState } from '../store/store.js';

/** Ctrl+K palette bound to the real command list, plus the global key map. */
export function PaletteHost() {
  const state = useAppState();
  const actions = useActions();
  const commands = useMemo(() => buildCommands(state, actions), [state, actions]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      const r = resolveKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, inEditable: isEditableTarget(e.target) });
      if (r && applyKey(r, stateRef.current, actions)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions]);

  const onSearch = (q: string) => {
    const text = q.trim();
    const id = ++seq.current;
    if (text.length < 2) { setResults([]); setBusy(false); return; }
    setBusy(true);
    void actions.search(text, 6).then((r) => { if (seq.current === id) { setResults(r); setBusy(false); } });
  };

  const items: SearchResultItem[] = results.map((r) => ({ id: r.id, title: r.title, ...(r.subtitle ? { subtitle: r.subtitle } : {}), icon: r.kind === 'place' ? 'pin' : r.kind === 'event' ? 'activity' : 'target', hint: r.kind }));

  return (
    <CommandPalette
      open={state.ui.paletteOpen}
      onClose={() => { actions.closePalette(); setResults([]); }}
      commands={commands}
      searchResults={items}
      onSearch={onSearch}
      onPickSearchResult={(item) => { const r = results.find((x) => x.id === item.id); if (r) void actions.goTo(r); }}
      busy={busy}
    />
  );
}
