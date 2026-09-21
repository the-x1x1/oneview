import { useEffect } from 'react';
import { ErrorState, LoadingState } from '@worldview/ui';
import { useAppState } from './store/store.js';
import { TopBar } from './components/top-bar.js';
import { LensRail } from './components/lens-rail.js';
import { MapHost } from './map/map-host.js';
import { ContextRail } from './components/context-rail.js';
import { TimelineBar } from './components/timeline-bar.js';
import { DemoBanner, Notifications, OfflineNotice } from './components/notices.js';
import { PaletteHost } from './components/palette-host.js';
import { SettingsDialog } from './dialogs/settings-dialog.js';
import { DiagnosticsDialog } from './dialogs/diagnostics-dialog.js';
import { AttributionDialog } from './dialogs/attribution-dialog.js';
import { WelcomeDialog } from './dialogs/welcome-dialog.js';
import './context/index.js';
import './shell.css';

/**
 * Primary layout (directive §53):
 *   top bar · left lens rail · centre map (largest surface) · right context rail · bottom timeline.
 * Dialogs and the palette overlay the grid; the demo banner sits under the top bar.
 */
export function Shell() {
  const { session } = useAppState();

  // Text scale and reduced motion are applied at the root so every token-based size follows.
  useEffect(() => {
    if (typeof document === 'undefined' || !session.settings) return;
    const root = document.documentElement;
    root.style.setProperty('--wv-text-scale', String(session.settings.textScale));
    root.setAttribute('data-reduced-motion', session.settings.reducedMotion ? 'true' : 'false');
  }, [session.settings]);

  if (session.status === 'error') {
    return <div className="wv-shell wv-shell--error"><ErrorState title="WORLDVIEW could not start" message={session.error ?? 'The runtime did not answer.'} /></div>;
  }

  return (
    <div className={`wv-shell${session.appInfo?.demoMode ? ' wv-shell--demo' : ''}`}>
      <TopBar />
      <DemoBanner />
      <OfflineNotice />
      <LensRail />
      <main className="wv-main" aria-label="World">
        {session.status === 'booting' ? <div className="wv-main__booting"><LoadingState label="Connecting to the runtime" /></div> : null}
        <MapHost />
      </main>
      <ContextRail />
      <TimelineBar />
      <Notifications />
      <PaletteHost />
      <SettingsDialog />
      <DiagnosticsDialog />
      <AttributionDialog />
      <WelcomeDialog />
    </div>
  );
}
