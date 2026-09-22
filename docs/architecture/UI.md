# UI architecture — design system and React shell

Packages: `@worldview/ui` (packages/ui) and the renderer shell (apps/desktop/src/renderer).
The shell consumes exactly one runtime API: `WorldClient` from `@worldview/ipc-contract`
(the preload bridge in Electron, `DemoClient` in the browser/demo build). It never imports
providers, engines, Electron or `node:*` (tools/dev/boundary-check.mjs enforces this).

## Layout (directive §53)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ top bar: wordmark · global search (combobox) · N objects · LIVE/DEGRADED/     │
│          OFFLINE badge · UTC clock · Ctrl+K · menu                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ "RECORDED DATA" banner (only when app.info.demoMode) · offline notice         │
├────────┬────────────────────────────────────────────────┬────────────────────┤
│ lens   │ map host (largest surface)                     │ context rail       │
│ rail   │  RendererHostLike mounted here                 │  tabs: Selection · │
│ Over-  │  2D/3D toggle (3D hidden when the host cannot) │  Sources · Timeline│
│ view … │  on-screen attribution                         │  · Related (+Feed, │
│ Envir- ├────────────────────────────────────────────────┤  Collections,      │
│ onment │ timeline bar: play/pause · 0.25–60× · scrub    │  Watch zones when  │
│        │ track with availability marks · LIVE           │  lens-visible/opened)│
└────────┴────────────────────────────────────────────────┴────────────────────┘
```

The grid lives in `shell.css` (`.wv-shell`); sizes come from tokens (`--wv-topbar-h`,
`--wv-context-w`, `--wv-timeline-h`). Text scale (`--wv-text-scale`) and reduced motion
(`:root[data-reduced-motion]`) are applied at the root from `AppSettings`.

## Design system (`@worldview/ui`, directive §55)

- `tokens.css`: 4-pt spacing, Inter/system-ui type with tabular numerals for data (`.wv-num`,
  `.wv-mono`), dark technical palette (`#0b0f14` background, surface layers, text hierarchy
  ≥ 4.5:1), restrained cyan accent, semantic colours for freshness (LIVE/RECENT/STALE/
  HISTORICAL/UNKNOWN), connection (CONNECTED/DEGRADED/OFFLINE), provider status, severity and
  confidence classes, radius/elevation, motion tokens that collapse to 0 ms under
  `prefers-reduced-motion` or the Settings toggle.
- Primitives (each `<name>/<name>.tsx` + `.css`): Icon (50 inline glyphs), Button/IconButton,
  Toggle (`role=switch`), Tabs (WAI-ARIA roving tabindex), Panel/FieldList/Section, Drawer,
  Popover, Tooltip, Search (combobox), CommandPalette (+ `ranking.ts`), VirtualList
  (+ `virtual-math.ts`), StatusBadge/SourceBadge, Timeline (+ `timeline-reducer.ts`),
  Empty/Error/Loading states, Dialog (focus trap, Esc, focus restore), formatters.
- Logic that can be pure is pure and tested without a DOM (node:test + `react-dom/server`
  `renderToStaticMarkup` for markup smoke tests). Stylesheets are imported by components;
  Vite bundles them, `tools/dev/asset-stub-hooks.mjs` stubs them under node:test.
- Honesty rules baked into components: `FieldList` omits rows whose value is undefined
  (no "—" for missing data); `Timeline` refuses to scrub when no availability window exists
  and says "No history available yet"; badges carry their meaning as text, never colour alone;
  `CommandPalette` omits unavailable commands instead of rendering them disabled.

## State model (apps/desktop/src/renderer/store)

`useReducer` + context, no libraries. `RootState` slices and the actions that mutate them
(`types.ts`, `reducer.ts`):

| slice                    | holds                                                                                                                                     | fed by                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| session                  | app.info, settings, boot status, first-run                                                                                                | `app.info`, `settings.get`, `settings.changed`                                                            |
| world                    | object mirror (`Map`), events, selection (+ full object, track, related), hover, view, subscription                                       | `world.subscribe` snapshot, `world.changed` deltas, `world.get/track/related/events`                      |
| sources                  | health entries, connection, manifests, credential presence                                                                                | `sources.list/connection`, `sources.changed`, `connection.changed`, `sources.manifest`, `credentials.has` |
| timeline                 | `TimelineControlState` (ui reducer) + last runtime `TimelineState`                                                                        | `timeline.get`, `timeline.changed`, user actions → `timeline.set`                                         |
| feed                     | items (bounded 500), unread                                                                                                               | `feed.recent`, `feed.item`                                                                                |
| lenses                   | definitions, active id                                                                                                                    | `lenses.list`, `lenses.changed`, settings.activeLensId                                                    |
| collections / watchzones | lists, active collection                                                                                                                  | `collections.*`, `watchzones.*`                                                                           |
| offline / updater        | status snapshots                                                                                                                          | `offline.status/changed`, `updater.state/changed`                                                         |
| ui                       | context tab (+ explicitly opened tabs), palette, dialog, render mode, host capabilities, source detail row, notifications, rail collapsed | shell actions                                                                                             |

- `sync.ts` (`bindClient`) issues the start-up requests and subscribes to every event channel,
  mapping each to a store action. `bootstrap-state.ts` does the same synchronously for tests
  and screenshot runs.
- `actions.ts` (`createActions`) is the only place that calls `client.request`. Panels, the
  palette and the key map call these typed actions; failures surface as notifications with the
  sanitized `IpcError` message.
- The world mirror is replaced on `world.subscribe` (lens types + padded/quantised viewport
  bounds at zoom ≥ 3 + pinned selection) and patched by `world.changed`. The selected object is
  kept in the mirror even when it leaves the subscription.
- `world.changed` crosses IPC and the context bridge as one JSON string
  (`shared/event-wire.ts`) and is parsed in the page by `wire-client.ts`. As an object graph it
  was copied twice — IPC deserialisation into the preload, then the bridge copy into the page —
  and a ~5,000-satellite refresh cost the page one 100–130 ms task every fifteen seconds before
  its handler ran. Other events are sent as they are.
- Map host (`map/map-host.tsx`): mounts the injected `RendererHostLike`, turns picks into
  selection, throttles `viewChanged` → `world.viewport` (500 ms), re-subscribes when the
  quantised bounds/lens/selection change, and runs `presentObjects` + `diffFeatures` from
  `@worldview/render-core` on the mirror at animation-frame cadence.
- `RendererHostLike` (`renderer-host-like.ts`) is the minimal surface the shell needs
  (`mount/unmount/setMode/activeMode/supportsMode?/getView/flyTo/select/setLens/setFeatures?/
setAttribution?/on`). The production `RendererHost` from render-core satisfies it
  structurally; the demo `CanvasRendererHost` implements it with a plain 2D canvas.

## Context panel registry (directive §62)

`context/registry.ts` composes the Selection panel from sections:

```ts
contextRegistry.register('*', DEFAULT_SECTIONS); // identity, position, freshness, sources, history, related
contextRegistry.register('aircraft', [aircraftSection]); // spliced after 'identity' by default
```

A section is `{ id, title, render(props), placement? }` where `props` carries the object,
its track, related items, source entries, the shell actions and `nowMs`; `render` returns
`null` to omit the section when the object has no data for it. A type section with the same
`id` as a default replaces it; `placement` is `{ after }`, `{ before }` or `'end'`.

### Adding a context section for a new object type

1. Create `apps/desktop/src/renderer/context/sections/<type>.tsx`:
   ```tsx
   import { FieldList } from '@worldview/ui';
   import { contextRegistry } from '../registry.js';
   import { num, str } from '../props.js';
   contextRegistry.register('storm', [
     {
       id: 'storm',
       title: 'Storm',
       render: ({ object }) => (
         <FieldList
           rows={[
             { label: 'Category', value: str(object, 'category') },
             { label: 'Max wind', value: num(object, 'maxWindMps') },
           ]}
         />
       ),
     },
   ]);
   ```
2. Import it from `context/index.ts`.
3. Use the property names the provider normalizer emits (see the provider's `normalize.ts`).

No renderer, store or panel code changes; rendering rules for the map live in render-core.

## Commands and keyboard (directive §134/§135)

`commands/commands.ts` builds the palette list from state (each entry runs a shell action;
unavailable ones are omitted). `commands/keyboard.ts` is the global key map: Ctrl/Cmd+K palette,
Esc closes palette → dialog → selection, `/` focuses search, `2`/`3` switch modes (3 only when
the host supports it), Space play/pause, `L` jump to live; lists and tabs handle arrow keys
themselves (roving tabindex / `aria-activedescendant`).

## Demo client (apps/desktop/src/renderer/demo)

`DemoClient` implements `WorldClient` in-process from fixtures: the USGS `normal.geojson`
contract fixture (embedded as `fixtures/usgs-normal.ts`, kept in sync by
`tools/dev/sync-demo-fixtures.mjs` and a test), 12 synthetic aircraft, 2 vessels and an
ISS-like satellite that move as pure functions of elapsed time, a fire detection, a weather
alert polygon and a camera whose snapshot is a synthetic SVG. Sources cover LIVE, STALE,
AUTH_REQUIRED, OFFLINE, RATE_LIMITED and DISABLED. `app.info.demoMode` is true, every
object's provenance is `recorded`, every feed item carries `recorded: true`, and the shell
shows the RECORDED DATA banner. `pnpm --filter @worldview/desktop dev:browser` serves the
shell with this client and the canvas host.

## Verification

```
node tools/dev/typecheck.mjs      # tsconfig.json + tsconfig.renderer.json (React shims when @types/react is absent)
node tools/dev/run-tests.mjs      # includes packages/ui and apps/desktop tests (DOM-free)
node tools/dev/boundary-check.mjs
node tools/dev/sync-demo-fixtures.mjs --check
```
