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

export type KeyResult = 'palette' | 'escape' | 'search' | 'mode2d' | 'mode3d' | 'togglePlay' | 'jumpLive' | null;

/**
 * Global key map (directive §134/§135), pure so it is testable:
 *   Ctrl/Cmd+K → palette · Esc → close palette/dialog, else clear selection · / → focus search
 *   2 / 3 → render modes · Space → play/pause · L → jump to live (outside editable controls).
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
    default:
      return false;
  }
}
