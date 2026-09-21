# Renderer entry contract

The renderer directory is owned by the UI workstream (`packages/ui` + `apps/desktop/src/renderer`). The desktop shell (main/preload) makes these promises and expects these files:

## What main/preload provide

- `window.worldview` — a `WorldBridge` (`@worldview/ipc-contract`): `request(channel, payload)` and `on(event, listener)`. Only catalogue channels work; unknown channels throw `IpcRequestError { code: 'DENIED' }`. Errors from main arrive as `IpcRequestError` with `{ code, message, channel }` and never carry stack traces or secrets.
- `platform` on the bridge (`win32`, `darwin`, `linux`).
- Events on `EVENT_CHANNELS` (`world.changed`, `sources.changed`, `connection.changed`, `timeline.changed`, `feed.item`, `notification`, `updater.changed`, `offline.changed`, `settings.changed`, `lenses.changed`).
- A strict CSP (`src/main/csp.ts`): no inline scripts, no `eval`, `style-src 'unsafe-inline'` (Cesium/MapLibre), `img-src`/`connect-src https:` for tiles, loopback for local sidecars, `worker-src blob:`.
- Navigation is locked to `dist/renderer/index.html` (production) or `http://localhost:5173` (development). `window.open` is denied; use `app.openExternal` (https, allowlisted hosts only).

## What the renderer must provide

- `index.html` at this directory root (Vite `root`), loading `./main.tsx`.
- `main.tsx` that picks the client and calls `createShell({ client })` from `./shell`:
  - Electron: `window.worldview` is present → use it directly (it implements `WorldClient`).
  - Browser / `pnpm dev:browser` / demo: `window.worldview` is absent → `DemoClient` from `@worldview/ui` (recorded data, labelled as such).
- No imports from `electron`, `node:*`, providers or runtime internals (enforced by `tools/dev/boundary-check.mjs`).
- Cesium static assets are served from `./cesium/` (`CESIUM_BASE_URL`, copied by `scripts/build-main.mjs --cesium-assets`).

Until the UI workstream's files are merged this directory contains only this file; `pnpm build` fails at the Vite step with a clear "index.html not found", which is the intended signal rather than a placeholder page.
