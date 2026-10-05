import type { ShellActions } from '../store/actions.js';
import type { RootState } from '../store/types.js';

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** True when focus is inside an editable control (input/textarea/select/contenteditable). */
  inEditable: boolean;
}

export type KeyResult =
  | 'palette'
  | 'escape'
  | 'search'
  | 'mode2d'
  | 'mode3d'
  | 'togglePlay'
  | 'jumpLive'
  | 'toggleHud'
  | 'toggleGrid'
  | 'toggleRangeRings'
  | 'nextStyle'
  | 'previousStyle'
  | 'toggleDayNight'
  | 'toggleOrbit'
  | 'toggleFollow'
  | 'toggleCleanView'
  | 'toggleMeasure'
  | 'goHome'
  | null;

/**
 * Global key map (directive §134/§135), pure so it is testable:
 *   Ctrl/Cmd+K → palette · Esc → close palette/dialog, else What's here, else leave clean view,
 *   else stop measuring, else clear selection · / → focus search · 2 / 3 → render modes · Space → play/pause · L → jump to live
 *   H → HUD · V / Shift+V → next / previous visual style · N → day and night · O → orbit ·
 *   F → follow the selection · C → clean view · M → measure · Home or Shift+H → the home view (all outside
 *   editable controls, and never with Ctrl, Cmd or Alt, so Ctrl+C still copies).
 */
export function resolveKey(input: KeyInput): KeyResult {
  const mod = input.ctrlKey || input.metaKey;
  if (mod && !input.altKey && input.key.toLowerCase() === 'k') return 'palette';
  if (input.key === 'Escape') return 'escape';
  if (input.inEditable || mod || input.altKey) return null;
  switch (input.key) {
    case '/':
      return 'search';
    case '2':
      return 'mode2d';
    case '3':
      return 'mode3d';
    case ' ':
      return 'togglePlay';
    case 'l':
    case 'L':
      return 'jumpLive';
    case 'Home':
      return 'goHome';
  }
  // Letters by what they are, not by the case Caps Lock gives them; only V and H read Shift.
  switch (input.key.toLowerCase()) {
    case 'h':
      return input.shiftKey ? 'goHome' : 'toggleHud';
    case 'v':
      return input.shiftKey ? 'previousStyle' : 'nextStyle';
    case 'n':
      return 'toggleDayNight';
    case 'o':
      return 'toggleOrbit';
    case 'f':
      return 'toggleFollow';
    case 'c':
      return 'toggleCleanView';
    case 'm':
      return 'toggleMeasure';
    case 'g':
      return 'toggleGrid';
    case 'r':
      return 'toggleRangeRings';
    default:
      return null;
  }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Applies a resolved key to the shell; returns true when the event was consumed. */
export function applyKey(result: KeyResult, state: RootState, actions: ShellActions): boolean {
  switch (result) {
    case 'palette':
      if (state.ui.paletteOpen) actions.closePalette();
      else actions.openPalette();
      return true;
    case 'escape':
      if (state.ui.paletteOpen) {
        actions.closePalette();
        return true;
      }
      if (state.ui.dialog) {
        if (state.ui.dialog === 'welcome') actions.finishWelcome();
        else actions.closeDialog();
        return true;
      }
      if (state.ui.whatsHere) {
        actions.closeWhatsHere();
        return true;
      }
      if (state.ui.cleanView) {
        actions.setCleanView(false);
        return true;
      }
      if (state.ui.measure) {
        actions.toggleMeasure();
        return true;
      }
      if (state.world.selectedId) {
        actions.clearSelection();
        return true;
      }
      return false;
    case 'search':
      actions.focusSearch();
      return true;
    case 'mode2d':
      void actions.setMode('2D');
      return true;
    case 'mode3d':
      if (!state.ui.supports3D) return false;
      void actions.setMode('3D');
      return true;
    case 'togglePlay':
      actions.timeline({ type: 'togglePlay' });
      return true;
    case 'jumpLive':
      actions.timeline({ type: 'jumpToLive' });
      return true;
    case 'toggleGrid':
      void actions.toggleGrid();
      return true;
    case 'toggleHud':
      void actions.toggleHud();
      return true;
    case 'nextStyle':
      void actions.cycleVisualStyle(1);
      return true;
    case 'previousStyle':
      void actions.cycleVisualStyle(-1);
      return true;
    case 'toggleDayNight':
      void actions.toggleDayNight();
      return true;
    case 'toggleOrbit':
      actions.setOrbit(!state.ui.orbit);
      return true;
    case 'toggleFollow':
      if (state.ui.followId !== null) {
        actions.setFollow(false);
        return true;
      }
      if (state.world.selectedKind !== 'object' || !state.world.selectedId) return false;
      actions.setFollow(true);
      return true;
    case 'toggleCleanView':
      actions.setCleanView(!state.ui.cleanView);
      return true;
    case 'toggleMeasure':
      actions.toggleMeasure();
      return true;
    case 'toggleRangeRings':
      actions.toggleRangeRings();
      return true;
    case 'goHome':
      actions.goHome();
      return true;
    default:
      return false;
  }
}
