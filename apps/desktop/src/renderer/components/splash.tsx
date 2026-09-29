import { useEffect, useRef, useState } from 'react';
import { useActions, useAppState } from '../store/store.js';
import { shouldFlyHomeAtStart } from '../store/home.js';

/** The splash never outstays this, whatever the renderer does: a map that cannot start must not hide the app. */
export const SPLASH_MAX_MS = 8_000;
const FADE_MS = 450;

export type SplashPhase = 'shown' | 'fading' | 'gone';

/** Where the splash is: up until the first frame (or the time limit), then a short fade, none with reduced motion. */
export function nextSplashPhase(
  phase: SplashPhase,
  event: 'firstFrame' | 'timeout' | 'faded',
  reducedMotion: boolean,
): SplashPhase {
  if (phase === 'gone') return 'gone';
  if (event === 'faded') return phase === 'fading' ? 'gone' : phase;
  return reducedMotion ? 'gone' : 'fading';
}

/**
 * The start-up splash (after OSIRIS's): the wordmark over the window while the renderer
 * builds its first picture, lifting on the first frame drawn rather than on a timer, so it
 * neither flashes away over an empty map nor lingers over a ready one. It never takes a
 * click — the welcome screen and anything else stay usable over it — and it goes after
 * SPLASH_MAX_MS whatever happens.
 *
 * Once the map has drawn, and only if the operator asked for it (the welcome screen or
 * Settings → Home view), the camera flies to the home view they set. Nothing locates the
 * operator: there is no IP lookup and no location permission, only the place they chose.
 */
export function Splash() {
  const { ui, session } = useAppState();
  const actions = useActions();
  const reducedMotion = session.settings?.reducedMotion ?? false;
  const [phase, setPhase] = useState<SplashPhase>('shown');
  const flown = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setPhase((p) => nextSplashPhase(p, 'timeout', reducedMotion)), SPLASH_MAX_MS);
    return () => clearTimeout(t);
    // The limit runs from the start; a change of reduced motion is no reason to restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (ui.firstFrame) setPhase((p) => nextSplashPhase(p, 'firstFrame', reducedMotion));
  }, [ui.firstFrame, reducedMotion]);
  useEffect(() => {
    if (phase !== 'fading') return undefined;
    const t = setTimeout(() => setPhase((p) => nextSplashPhase(p, 'faded', reducedMotion)), FADE_MS);
    return () => clearTimeout(t);
  }, [phase, reducedMotion]);

  // The start-up flight home: once, after the first frame, when asked for.
  const home = session.settings?.home;
  useEffect(() => {
    if (!shouldFlyHomeAtStart(home, ui.firstFrame, flown.current)) return;
    flown.current = true;
    actions.goHome();
  }, [home, ui.firstFrame, actions]);

  if (phase === 'gone') return null;
  return (
    <div className={`wv-splash${phase === 'fading' ? ' wv-splash--fading' : ''}`} aria-hidden="true">
      <span className="wv-splash__wordmark">WORLDVIEW</span>
      <span className="wv-splash__status">
        {session.status === 'booting' ? 'Starting the runtime' : 'Drawing the map'}
      </span>
    </div>
  );
}
