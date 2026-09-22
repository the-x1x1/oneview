import type { WebContents } from 'electron';
import type { Logger } from '@worldview/core';

/**
 * A window that opens and shows nothing is the worst failure this app can have: it reports
 * success everywhere — exit code 0, a clean build, a healthy main process, an empty log —
 * while the user is looking at a rectangle. It happened twice for different reasons, and
 * both times the only way to find out why was to reason about it from the outside.
 *
 * So the renderer now reports on itself. Anything it prints is kept, and if the shell has
 * not mounted shortly after the document finishes loading, whatever was collected is drawn
 * into the window. The next blank screen explains itself.
 */
export interface RendererReport {
  level: string;
  message: string;
  source?: string;
  line?: number;
}

const LEVELS = ['debug', 'info', 'warning', 'error'];

export function describeReports(reports: RendererReport[]): string {
  if (reports.length === 0) return 'The renderer reported nothing at all — no script ran, and no error was raised.';
  return reports
    .map((r) => `[${r.level}] ${r.message}${r.source ? `\n    ${r.source}${r.line ? `:${r.line}` : ''}` : ''}`)
    .join('\n');
}

/**
 * Built as DOM nodes with `textContent`, never `innerHTML`: the text here includes console
 * output that may have come from a provider feed, and this page exists precisely for the
 * moments when everything else has gone wrong.
 */
export function diagnosticScript(detail: string): string {
  return `(() => {
    if (document.getElementById('wv-diagnostic')) return;
    var host = document.body || document.documentElement;
    var box = document.createElement('div');
    box.id = 'wv-diagnostic';
    box.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:28px 32px;background:#0b0f14;color:#c8d4e0;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace');
    var h = document.createElement('div');
    h.setAttribute('style', 'font:600 17px/1.4 system-ui,sans-serif;color:#e0b24a;margin-bottom:6px');
    h.textContent = 'WORLDVIEW loaded but drew nothing';
    var sub = document.createElement('div');
    sub.setAttribute('style', 'color:#8ea0b4;margin-bottom:18px;font:13px/1.6 system-ui,sans-serif');
    sub.textContent = 'The window and the main process are fine. This is what the renderer reported:';
    var pre = document.createElement('pre');
    pre.setAttribute('style', 'white-space:pre-wrap;word-break:break-word;margin:0;padding:16px;background:#111823;border:1px solid #1f2a38;border-radius:6px');
    pre.textContent = ${JSON.stringify(detail)};
    box.appendChild(h); box.appendChild(sub); box.appendChild(pre);
    host.appendChild(box);
  })()`;
}

/** Did the shell actually mount? `#root` is where React attaches (renderer/index.html). */
const MOUNT_PROBE = "(function () { var r = document.getElementById('root'); return r ? r.childElementCount : -1; })()";

export function watchRenderer(contents: WebContents, log: Logger, opts: { graceMs?: number } = {}): void {
  const graceMs = opts.graceMs ?? 4000;
  const reports: RendererReport[] = [];

  contents.on('console-message', (_e, level, message, line, sourceId) => {
    const named = LEVELS[level] ?? String(level);
    // Everything is kept for the diagnostic page; only real problems reach the log.
    reports.push({ level: named, message, ...(sourceId ? { source: sourceId } : {}), ...(line ? { line } : {}) });
    if (named === 'error' || named === 'warning')
      log.warn('renderer console', { level: named, message: message.slice(0, 400), source: sourceId.slice(-80), line });
  });

  contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    reports.push({
      level: 'error',
      message: `the document failed to load: ${errorDescription} (${errorCode})`,
      source: validatedURL,
    });
    log.error('renderer failed to load', { errorCode, errorDescription, url: validatedURL.slice(0, 200) });
  });

  contents.on('did-finish-load', () => {
    setTimeout(() => {
      if (contents.isDestroyed()) return;
      void contents
        .executeJavaScript(MOUNT_PROBE)
        .then(async (mounted) => {
          if (typeof mounted === 'number' && mounted > 0) return;
          const detail = describeReports(reports);
          log.error('renderer drew nothing', {
            rootChildren: typeof mounted === 'number' ? mounted : String(mounted),
            reports: reports.length,
            detail: detail.slice(0, 2000),
          });
          if (!contents.isDestroyed()) await contents.executeJavaScript(diagnosticScript(detail));
        })
        .catch((error: unknown) =>
          log.error('renderer watchdog failed', { error: error instanceof Error ? error.message : String(error) }),
        );
    }, graceMs);
  });
}
