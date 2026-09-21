import { useEffect, useRef, useState } from 'react';
import type { SearchResult } from '@worldview/ipc-contract';
import { IconButton, Popover, Search, StatusBadge, formatUtcTime, type IconName, type SearchResultItem } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';
import { useNow } from '../hooks/use-now.js';

const KIND_ICON: Record<SearchResult['kind'], IconName> = { place: 'pin', object: 'target', event: 'activity', command: 'command', query: 'search' };

function toItem(r: SearchResult): SearchResultItem {
  return { id: r.id, title: r.title, ...(r.subtitle ? { subtitle: r.subtitle } : {}), icon: KIND_ICON[r.kind], hint: r.kind };
}

/** Top bar (directive §53): global search, connection/state badge, UTC clock, app menu. */
export function TopBar() {
  const { sources, world, session, ui } = useAppState();
  const actions = useActions();
  const now = useNow(1000);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const text = query.trim();
    if (!text) { setResults([]); setBusy(false); return; }
    const id = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      void actions.search(text).then((r) => { if (seq.current === id) { setResults(r); setBusy(false); } });
    }, 150);
    return () => clearTimeout(t);
  }, [query, actions]);

  const connection = sources.connection;
  const offline = connection?.state === 'OFFLINE';
  const objectCount = world.objects.size;
  const items = results.map(toItem);

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
          onPick={(item) => { const r = results.find((x) => x.id === item.id); if (r) { void actions.goTo(r); setQuery(''); } }}
          onEscape={() => setQuery('')}
          footer={offline ? 'Offline — searching the local index and cached state only' : `Press / to focus · ${items.length ? `${items.length} results` : 'places, callsigns, MMSI, event titles'}`}
        />
      </div>
      <div className="wv-topbar__status">
        <span className="wv-topbar__count wv-num" title="Objects in view subscription">{objectCount.toLocaleString('en-US')} objects</span>
        {connection ? (
          <StatusBadge kind="connection" value={connection.state} title={`${connection.remoteLive}/${connection.remoteTotal} remote sources live · ${connection.localLive} local`} />
        ) : (
          <StatusBadge kind="freshness" value="UNKNOWN" title="Connection state not yet reported" />
        )}
        <span className="wv-topbar__clock wv-mono" aria-label="UTC time" title="Coordinated Universal Time">{formatUtcTime(now)} <span className="wv-topbar__utc">UTC</span></span>
        <IconButton icon="command" label="Command palette (Ctrl+K)" onClick={() => actions.openPalette()} pressed={ui.paletteOpen} />
        <Popover
          label="Application menu"
          align="end"
          renderTrigger={(p) => <IconButton icon="menu" label="Menu" {...p} />}
        >
          <ul className="wv-menu" role="menu">
            <li role="none"><button type="button" role="menuitem" className="wv-menu__item" onClick={() => actions.openDialog('settings')}>Settings</button></li>
            <li role="none"><button type="button" role="menuitem" className="wv-menu__item" onClick={() => actions.setContextTab('sources')}>Source health</button></li>
            <li role="none"><button type="button" role="menuitem" className="wv-menu__item" onClick={() => actions.setContextTab('collections')}>Collections</button></li>
            <li role="none"><button type="button" role="menuitem" className="wv-menu__item" onClick={() => actions.setContextTab('watchzones')}>Watch zones</button></li>
            <li role="none" className="wv-menu__sep" />
            <li role="none"><button type="button" role="menuitem" className="wv-menu__item" onClick={() => actions.openDialog('attribution')}>Data &amp; attribution</button></li>
            <li role="none"><button type="button" role="menuitem" className="wv-menu__item" onClick={() => actions.openDialog('diagnostics')}>Help → Diagnostics</button></li>
            <li role="none"><button type="button" role="menuitem" className="wv-menu__item" onClick={() => actions.openDialog('welcome')}>About WORLDVIEW</button></li>
          </ul>
        </Popover>
      </div>
    </header>
  );
}
