import { Button, Dialog, Icon } from '@worldview/ui';
import { useActions, useAppState } from '../store/store.js';

/**
 * First-run welcome (directive §133): one screen — what WORLDVIEW is, the privacy
 * boundary, "Start with Earth". Optional links to sources and offline packs. It never
 * blocks: the map is already loading behind it and Esc/Start dismiss it.
 */
export function WelcomeDialog() {
  const { ui, session, offline } = useAppState();
  const actions = useActions();
  if (ui.dialog !== 'welcome') return null;
  const finish = () => actions.finishWelcome();
  return (
    <Dialog open title="Welcome to WORLDVIEW" onClose={finish} size="md" description="A local-first browser for the physical world — live, historical and offline."
      footer={<>
        {session.appInfo?.demoMode ? <span className="wv-welcome__demo">Demo build: recorded data only</span> : null}
        <Button variant="primary" icon="globe" onClick={finish} autoFocus>Start with Earth</Button>
      </>}>
      <div className="wv-welcome">
        <section className="wv-welcome__block">
          <h3><Icon name="globe" size={16} /> What it shows</h3>
          <p>Aircraft, ships, satellites, earthquakes, fires, weather alerts, infrastructure and public cameras from documented sources, each labelled with its freshness and provenance. Lenses on the left focus the world; the timeline at the bottom replays what has been recorded.</p>
        </section>
        <section className="wv-welcome__block">
          <h3><Icon name="key" size={16} /> Privacy boundary</h3>
          <ul>
            <li>Runs on your machine. No accounts, no telemetry, no cloud relay.</li>
            <li>Models places, objects and events — never people. No face, plate or person search.</li>
            <li>Credentials for optional sources go to the operating system secure store and are never displayed.</li>
            <li>Camera frames are shown as served and not retained by default.</li>
          </ul>
        </section>
        <section className="wv-welcome__block wv-welcome__links">
          <Button variant="ghost" icon="database" onClick={() => { finish(); actions.setContextTab('sources'); }}>Configure sources</Button>
          {offline.status?.capabilities.localMap === false || !offline.status ? <Button variant="ghost" icon="download" onClick={() => { finish(); void actions.installOfflinePack(); }}>Install offline pack</Button> : null}
          <Button variant="ghost" icon="info" onClick={() => { finish(); actions.openDialog('attribution'); }}>Data &amp; attribution</Button>
        </section>
      </div>
    </Dialog>
  );
}
