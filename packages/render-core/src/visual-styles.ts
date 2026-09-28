/**
 * Visual styles: a look for the whole map, chosen in Settings → Map → Visual style or cycled
 * with V. Each renderer draws them its own way — the globe as one full-screen post-process
 * pass (render-cesium visual-styles.ts), the 2D map as an SVG colour filter and a CSS
 * overlay on its pane (render-maplibre visual-styles.ts) — from this one list.
 *
 * The list is the settings contract's (ipc-contract `VISUAL_STYLE_IDS`) restated here because
 * render-core does not depend on the IPC package; a test in apps/desktop keeps the two equal.
 *
 * Every style is static: none of them animates, so a still view with a style on still draws
 * nothing (the globe runs in request-render mode). Grain and scanlines are fixed patterns
 * keyed to pixel position, not to time.
 */
export const VISUAL_STYLE_IDS = ['standard', 'night-vision', 'thermal', 'crt', 'noir'] as const;
export type VisualStyleId = (typeof VISUAL_STYLE_IDS)[number];

export function isVisualStyleId(value: unknown): value is VisualStyleId {
  return typeof value === 'string' && (VISUAL_STYLE_IDS as readonly string[]).includes(value);
}

/** The style after (`step` 1) or before (`step` −1) this one, wrapping round. */
export function nextVisualStyle(current: VisualStyleId | undefined, step: 1 | -1 = 1): VisualStyleId {
  const i = current ? VISUAL_STYLE_IDS.indexOf(current) : 0;
  const n = VISUAL_STYLE_IDS.length;
  return VISUAL_STYLE_IDS[((((i < 0 ? 0 : i) + step) % n) + n) % n]!;
}
