/**
 * Work offline (Settings → Network; `AppSettings.network.workOffline`): WorldView asks
 * nothing of the internet while it is on. One switch, applied at every door out of the app:
 *
 *  - the runtime's fetch (providers, the reachability probe, camera stills) — `gatedFetch`;
 *  - Electron's `net` in main (the tile cache, online place search, the updater) and every
 *    request the page makes (map tiles, imagery) — `blockInternetRequests` on the session;
 *  - the connectivity signal the runtime folds into its verdict reads offline, so sources
 *    pause as they do when the cable is out and the shell says so.
 *
 * Requests to this computer stay allowed (the camera relay, go2rtc, a local receiver), and so
 * do the app's own schemes (`worldview:`, `file:`, `data:`, `blob:`). A source on the
 * operator's own network (a broker or receiver they named) keeps running: that is not the
 * internet, and the switch says so.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Whether a URL leaves this computer for the network: http(s) or ws(s) to a non-loopback host. */
export function leavesThisComputer(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  return !(LOOPBACK.has(host) || host.endsWith('.localhost') || /^127\./.test(host));
}

export class WorkingOfflineError extends Error {
  constructor(url: string) {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* keep the text */
    }
    super(`working offline: ${host} not asked`);
    this.name = 'WorkingOfflineError';
  }
}

/** A fetch that refuses, without sending anything, every request that would leave this computer while offline. */
export function gatedFetch(inner: typeof fetch, workingOffline: () => boolean): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (workingOffline() && leavesThisComputer(url)) return Promise.reject(new WorkingOfflineError(url));
    return inner(input, init);
  }) as typeof fetch;
}

/** The part of Electron's session this needs. */
export interface RequestFilterSession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (details: { url: string }, callback: (response: { cancel?: boolean }) => void) => void,
    ): void;
  };
}

/** Cancel, on the session, every page and `net` request that would leave this computer while offline. */
export function blockInternetRequests(
  session: RequestFilterSession,
  workingOffline: () => boolean,
  onBlocked?: (url: string) => void,
): void {
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const cancel = workingOffline() && leavesThisComputer(details.url);
      if (cancel) onBlocked?.(details.url);
      callback(cancel ? { cancel: true } : {});
    },
  );
}
