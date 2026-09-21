# ADR-004 — Desktop platform: Electron + Vite + React, Windows x64 first

Status: Accepted · 2026-09-21 · Package: `apps/desktop`, `@worldview/ipc-contract`

## Decision
- Electron (current stable) with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, no `eval`, no remote module. Main process hosts the runtime (providers, state, history, offline, cameras, updater); the renderer hosts React + the render adapters.
- IPC is an allowlisted, typed request catalogue (`WorldRequests`) and event catalogue (`WorldEvents`) in `@worldview/ipc-contract`; the preload exposes `window.worldview` implementing `WorldClient`. The same interface is implemented in-process for browser development and demo mode, so the shell never branches on platform.
- Secrets use Electron `safeStorage` (DPAPI on Windows) via `credentials.set`; the renderer never receives values.
- Packaging: electron-builder → `WorldView-Setup-x.y.z.exe` (NSIS) and `WorldView-Portable-x.y.z.zip`. Node 22 LTS, pnpm 10.28.0 pinned.
- Tests use Node's built-in `node:test` runner through `tsx` (zero framework dependencies; the same runner GEV uses), grouped by directory convention (`tools/dev/run-tests.mjs`).
- 2026-09-21 amendment (first-run state): whether the welcome flow has been completed is persisted settings state (`AppSettings.firstRunCompleted`), not renderer storage. The interface has no durable store of its own — `localStorage` is unavailable under the sandbox, is per-origin rather than per-installation, and would disagree with the settings file after a reset or a portable/installed switch — so `finishWelcome()` writes through `settings.set` like every other preference and the runtime remains the single source of truth.

## Consequences
The renderer cannot touch the filesystem, network (beyond map tiles allowed by CSP) or child processes; every capability is an IPC action with a schema.
