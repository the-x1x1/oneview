/**
 * Build-time facts injected by apps/desktop/scripts/build-main.mjs through esbuild
 * `define` (`__WORLDVIEW_BUILD__`). Absent in dev/tsx runs, so every field has an
 * honest fallback: unsigned, unknown commit, dev channel.
 */
export interface BuildInfo {
  /** True only when the packaging step ran with a code-signing certificate (SIGNING_REQUIRED blocker until then). */
  signed: boolean;
  commit: string;
  channel: 'stable' | 'prerelease' | 'dev';
  buildTime: string;
}

declare const __WORLDVIEW_BUILD__: Partial<BuildInfo> | undefined;

export function buildInfo(): BuildInfo {
  const injected: Partial<BuildInfo> =
    typeof __WORLDVIEW_BUILD__ === 'object' && __WORLDVIEW_BUILD__ !== null ? __WORLDVIEW_BUILD__ : {};
  return {
    signed: injected.signed === true,
    commit: typeof injected.commit === 'string' && injected.commit.length > 0 ? injected.commit : 'unknown',
    channel: injected.channel === 'stable' || injected.channel === 'prerelease' ? injected.channel : 'dev',
    buildTime: typeof injected.buildTime === 'string' ? injected.buildTime : 'unknown',
  };
}
