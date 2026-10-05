import { useEffect, useRef, useState } from 'react';
import type { SearchResult } from '@worldview/ipc-contract';
import { IconButton, Popover, Search, StatusBadge, formatUtcTime } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { useNow } from '../hooks/use-now.js';
import { ONLINE_ROW_ID, onlinePlaceText, searchList, type OnlineSearchState } from './search-items.js';

/** Top bar (directive §53): global search, connection/state badge, UTC clock, app menu. */
export function TopBar() {
  const { sources, world, session, ui } = useAppState();
  const actions = useActions();
  const now = useNow(1000);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  /** The text `results` answer; while it differs from what is typed, they are still coming. */
  const [resultsFor, setResultsFor] = useState('');
  /** Enter pressed on the default row before this text's results arrived: act when they do. */
  const [pendingEnter, setPendingEnter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState<OnlineSearchState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const seq = useRef(0);
  /** A menu item acts and closes the menu; it used to stay open behind the dialog it opened. */
  const pick = (act: () => void) => () => {
    setMenuOpen(false);
    act();
  };

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResults([]);
      setResultsFor('');
      setBusy(false);
      return;
    }
    const id = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      void actions.search(text).then((r) => {
        if (seq.current === id) {
          setResults(r);
          setResultsFor(text);
          setBusy(false);
        }
      });
    }, 150);
    return () => clearTimeout(t);
  }, [query, actions]);

  const connection = sources.connection;
  // Work offline (Settings → Network) is offline whatever the cable says.
  const workingOffline = session.settings?.network?.workOffline === true;
  const offline = workingOffline || connection?.state === 'OFFLINE';
  const objectCount = world.objects.size;
  const list = searchList({
    text: query,
    local: results,
    online,
    offline,
    enabled: session.settings?.search?.online !== false,
  });
  const items = list.items;
  const settled = resultsFor === query.trim();
  // One request, on the operator's word (Enter or a click on the row), never while typing.
  const searchOnline = () => {
    const text = onlinePlaceText(query);
    if (!text || (online?.text === text && online.busy)) return;
    setOnline({ text, busy: true, answer: null });
    void actions
      .searchPlaces(text)
      .then((answer) => setOnline((prev) => (prev?.text === text ? { text, busy: false, answer } : prev)));
  };

  /** Act on a row: the online row asks OpenStreetMap; any other goes to its result. */
  const act = (item: { id: string }) => {
    if (item.id === ONLINE_ROW_ID) {
      searchOnline();
      return;
    }
    const r = list.results.find((x) => x.id === item.id);
    if (r) {
      void actions.goTo(r);
      setQuery('');
    }
  };

  // Typing "switch to 3D" and pressing Enter at once used to find only the online row (the
  // local results come 150 ms after the last key), so the command went to OpenStreetMap.
  // Enter on the default row now waits for this text's results and takes the first of them.
  useEffect(() => {
    if (pendingEnter === null || !settled) return;
    setPendingEnter(null);
    if (pendingEnter !== query.trim()) return;
    const first = items[0];
    if (first) act(first);
    // `act` and `items` are this render's; the effect runs once per arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEnter, settled, query]);

  return (
    <header className="wv-topbar" role="banner">
      <div className="wv-topbar__brand" aria-label="WORLDVIEW">
        <span className="wv-topbar__wordmark">WORLDVIEW</span>
        {session.appInfo?.demoMode ? <span className="wv-topbar__demo">demo</span> : null}
      </div>
      <div className="wv-topbar__search" id="wv-global-search">
        <Search
          label="Search places, objects and events"
          value={query}
          onChange={setQuery}
          results={items}
          busy={busy}
          onPick={(item, how) => {
            if (how === 'default' && !settled) {
              setPendingEnter(query.trim());
              return;
            }
            act(item);
          }}
          onEscape={() => setQuery('')}
          footer={list.footer}
        />
      </div>
      <div className="wv-topbar__status">
        <span className="wv-topbar__count wv-num" title="Objects in view subscription">
          {objectCount.toLocaleString('en-US')} objects
        </span>
        {connection ? (
          <StatusBadge
            kind="connection"
            value={workingOffline ? 'OFFLINE' : connection.state}
            title={
              workingOffline
                ? 'Working offline (Settings → Network): nothing is asked of the internet'
                : `${connection.remoteLive}/${connection.remoteTotal} remote sources live · ${connection.localLive} local`
            }
          />
        ) : (
          <StatusBadge kind="freshness" value="UNKNOWN" title="Connection state not yet reported" />
        )}
        <span className="wv-topbar__clock wv-mono" aria-label="UTC time" title="Coordinated Universal Time">
          {formatUtcTime(now)} <span className="wv-topbar__utc">UTC</span>
        </span>
        <IconButton
          icon="command"
          label="Command palette (Ctrl+K)"
          onClick={() => actions.openPalette()}
          pressed={ui.paletteOpen}
        />
        <Popover
          label="Application menu"
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          renderTrigger={(p) => <IconButton icon="menu" label="Menu" {...p} />}
        >
          <ul className="wv-menu" role="menu">
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="wv-menu__item"
                onClick={pick(() => actions.openDialog('settings'))}
              >
                Settings
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="wv-menu__item"
                onClick={pick(() => actions.setContextTab('sources'))}
              >
                Source health
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="wv-menu__item"
                onClick={pick(() => actions.setContextTab('collections'))}
              >
                Collections
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="wv-menu__item"
                onClick={pick(() => actions.setContextTab('watchzones'))}
              >
                Watch zones
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="wv-menu__item"
                onClick={pick(() => void actions.savePicture())}
              >
                Save a picture of the map
              </button>
            </li>
            <li role="none" className="wv-menu__sep" />
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="wv-menu__item"
                onClick={pick(() => actions.openDialog('attribution'))}
              >
                Data &amp; attribution
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="wv-menu__item"
                onClick={pick(() => actions.openDialog('diagnostics'))}
              >
                Help → Diagnostics
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="wv-menu__item"
                onClick={pick(() => actions.openDialog('welcome'))}
              >
                About WORLDVIEW
              </button>
            </li>
          </ul>
        </Popover>
      </div>
    </header>
  );
}
