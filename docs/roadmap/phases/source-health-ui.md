# Phase `source-health-ui` — Sources and Source Health show connectors; the operator's folder in-app

Status: complete at `a27f587` (work `02f0056`, review fixes `f86016a` + `a27f587`; this evidence is the commit after it), on `origin/develop` @ `59d546d` · Branch: `phase/source-health-ui` · Target: 0.2.0 · Owner: session 017GsK (2026-09-24)

## Goal

An operator can see which sources are connector definitions and which connector runs
them, open the folder where their own definitions live, reload it without restarting,
enable or disable each definition, and read why a file was rejected — all from Sources.
An "Add source" dialog drafts a definition from a URL the way `connector:add` does, into
that folder, and shows the validator's result.

## Read first

[PARALLEL-PHASES.md](../PARALLEL-PHASES.md); ADR-013; ADR-004 (desktop, IPC);
`apps/desktop/src/renderer/panels/sources-panel.tsx`; `packages/ipc-contract` (`sources.*`);
`packages/runtime/src/core.ts` (`connectorDefinitions()`); `packages/connector-runtime/src/draft.ts`
(the drafter, reusable from the main process once the amendment exposes it); `docs/architecture/UI.md`.

## Scope

In: the Sources panel — a "Connector" column/badge (`rest-json`, `geojson`, …) and the
definition file name in the source's detail; a "Definitions" section: folder path, Open
folder, Reload, per-file enabled switch, rejected files with reasons; the "Add source"
dialog: URL → draft → validation result → save into the folder (disabled until enabled by
the operator) — the draft is the one `draft.ts` produces, moved to a shared location by the
amendment. Source Health: the connector name in the entry's meta. Keyboard and screen-reader
parity with the existing panel; no horizontal scrollbar in the sources leaf (a known
constraint).

Out: editing a definition's JSON in-app (the file is opened in the OS editor); review
status changes; credentials UI changes beyond what the manifest already drives.

## Deliverables

1. Amendment request written first (below); the panel built against the extended IPC
   types with a mock client in tests; the UI degrades cleanly (no Definitions section) when
   the IPC reports no folder.
2. `apps/desktop/src/renderer/panels/sources-panel.tsx` changes and any new
   `sources-definitions.tsx` / `sources-connector-badge.tsx` (owned globs);
   `apps/desktop/src/renderer/dialogs/add-source-dialog.tsx`.
3. Renderer tests (`sources-*.test.ts`) for the badge, the definitions list, rejection
   display, the dialog flow with a mocked `sources.definitions.draft`.
4. A `docs/OPERATOR-GUIDE.md` section is the integrator's (frozen); write the text in the
   brief under "Operator guide text" for the integrator to paste.
5. Changelog fragment; status and evidence (screenshots on the packaged build).

## Definition of done

- [x] renderer tests green; typecheck (renderer program) green
- [ ] verified on the packaged Windows build: badge, folder, reload, enable, rejected reason,
      add-source draft (the integrator's screenshots)
- [x] `phase-check` passes; all common checks the container can run green (format and lint
      are the Windows gate's)

## What was built

1. Deliverable 1: built on the landed amendment (#9), no shim. `folder: null` (demo mode,
   tests) renders no Definitions section and no Add source button; the table reads as before.
   A listing that fails is shown with Try again rather than hidden.
2. `panels/sources-connector-badge.tsx` — the connector id as a small neutral pill on the
   source's locality line, inside the name cell (not a new column: the table is fixed-width
   and must not scroll sideways; a long id ends in an ellipsis). The open row's detail adds
   Connector and Definition file (`bundled/x.json` reads `x.json (shipped)`).
   `panels/sources-definitions.tsx` + `sources-definitions-model.ts` — the Definitions
   section below the table: folder path, Open folder, Reload (one at a time; says what it
   started, restarted and stopped), Add source, and every file (the operator's first, then
   the shipped ones) with its id, state, connector, an enabled switch for files that loaded,
   the reasons a file was rejected, and validator notes behind a disclosure. A switch waits
   for the runtime; an older answer never replaces a newer one, and overlapping changes are
   listed again once they settle. Enabled state follows the live source list, so the file's
   switch and the source row's switch agree. Waiting controls stay focusable
   (`aria-disabled`, repeats ignored) so focus never drops to the page.
   `dialogs/add-source-dialog.tsx` — address (https, no credentials and no key-like query
   parameter in it, since the address is copied into the file; checked before sending) →
   `sources.definitions.draft` →
   connector, verdict, errors, the drafter's to-do list and notes, the drafted JSON behind a
   disclosure, an editable id (the runtime's rule, and ids already used by a source or a file
   refused before sending) → `sources.definitions.save` → saved, disabled, with Open folder
   and Add another (Open folder reports a failure in the dialog). A draft that does not
   validate cannot be saved. The dialog can be closed at any time: a draft answering after
   it closed, or after Start over, is dropped; a save that lands after it closed still updates
   the list. Each step moves focus to what it shows and one live region says what happened.
   Every error code the amendment names reads as a sentence; the URL-policy hint is added
   only to the drafter's own refusals (DENIED is also the router's rate limit).
3. Tests with a scripted client (`panels/sources-test-client.ts`) and `DemoClient`:
   `panels/sources-definitions.test.ts` (17), `panels/sources-connector-badge.test.ts` (4),
   `dialogs/add-source-dialog.test.ts` (12). They were checked against deliberately broken
   code (stale answers applied, the folder check removed, rejected files given a switch).
   The Definitions section itself is not in the panel's static render (its listing is read in
   an effect); it is tested through `DefinitionsSection` with a loaded controller, and the
   panel's own wiring (the taken-id set, `onSaved` → `applySaved`, the button opening the
   dialog) through `takenIdsFor` and the controller only — not by driving `SourcesPanel`.
4. Operator guide text below.
5. Changelog fragment `docs/roadmap/phases/changelog/source-health-ui.md`.

Independent review (a subagent, against this brief), two passes. First pass: stale error
after Try again, DENIED wording under the rate limit, the "disabled" claim after a save
(request 2), focus lost on waiting controls, no live announcement of a draft, Cancel blocked
while drafting, keys in the query string reaching the file, the badge's ellipsis on a flex
box, lower-case error fragments, Open folder failing silently in the dialog, and weak
assertions — fixed with tests. Second pass: key parameters the pattern missed (`appid`,
`api_token`, `subscription-key`, …), waiting controls that looked active, a silent waiting
switch, "Draft ready" announced after a failed save, Open folder doing nothing during a
reload, focus on opening — fixed, with tests for all but the focus moves (they run in effects,
which need a DOM this suite does not have). Left as noted: `SourcesPanel` wiring is not
driven in a test (above); a bare `key=` parameter is refused outright, which also refuses
public ids passed as `key` — the operator drafts without it and adds it to the file.

Decisions: no Connector column (a badge in the name cell keeps the four fixed columns);
no CSS file is owned by this phase, so the new markup reuses the panel's classes and sets
its few wrapping rules inline (the CSP allows inline styles); the dialog is opened from the
Definitions section, so it exists only where a folder does. No store, action or IPC
change.

## Design notes

- `SourceHealthEntry.meta` is where the panel reads manifest facts; the amendment adds
  `connector?` and `definitionFile?` there (source-health package) and a
  `sources.definitions.*` request family.
- Reload must be safe while providers run: the runtime stops providers whose files went
  away, starts new ones, restarts changed ones; the amendment names that behaviour.
- The drafter runs in the main process (network from main, through the same URL policy);
  the renderer only asks.

## Amendment requests

- **Integrated (2026-09-24):** merged at `8fc052f`; requests **2 and 3 landed**: a saved definition starts disabled even when an earlier source with its id was left on (`save` switches the setting off first), and `setEnabled` runs inside `serial()` with reload and save. The dialog's "unless an earlier source…" note can go in a follow-up.

- **ADR-013 / ADR-004: landed** (2026-09-24 amendment, integrator item #9). As requested,
  with these details: `DefinitionFileEntry` also carries `connector?`, `bundled` and
  `warnings`; `sources.definitions.reload` returns the listing plus `added`, `removed`,
  `restarted` (ids); `setEnabled` returns the listing; `openFolder` → `{ opened, folder }`;
  `draft` → `DefinitionDraft { definition, connector, notes, todo, validation: { ok, errors,
warnings } }`; `save` → `{ file, listing }` and reloads, so the new source appears
  disabled. Demo mode (and the renderer's demo client) report `folder: null` with no files,
  and draft/save answer UNAVAILABLE — the "no folder → no Definitions section" path. Errors
  come back as INVALID_REQUEST (bad id, not valid, exists, taken, refused file), NOT_FOUND
  (unknown file), DENIED (URL policy) or UNAVAILABLE (fetch failed, no folder), each with a
  message fit to show.
- (original request) **ADR-013 / ADR-004:** `SourceHealthEntry.meta.connector?: string`,
  `meta.definitionFile?: string`; IPC `sources.definitions.list` → `{ folder, files: [{
file, id?, enabled, problems: string[] }] }`, `sources.definitions.reload`,
  `sources.definitions.setEnabled { file, enabled }`, `sources.definitions.openFolder`,
  `sources.definitions.draft { url } → { definition, notes, todo, validation }` (the
  drafter moved to `packages/connector-runtime/src/draft.ts` from the validator tool), and
  `sources.definitions.save { id, definition } → { file }` (refuses to overwrite).
- **Request 2 (runtime, frozen; found in review 2026-09-24):** a saved definition can start
  **enabled**. `ConnectorDefinitions.saveNow` writes the file `enabled: false`, but
  `reloadNow` registers it with `enabledSetting(id) ?? enabledByDefault`, and
  `settings.providers[id].enabled` survives the file that set it. Enable `my-stations`,
  delete its file, reload, then Add source with the id `my-stations`: the new source runs at
  once. Smallest change: `saveNow` persists `enabled: false` for the id before its reload
  (or ignores a stored setting for a file it has just written). Until then the dialog and the
  Definitions notice read the saved file's `enabled` from the returned listing and say "It is
  ON" with the reason, rather than claiming it is disabled.
- **Request 3 (runtime, frozen):** `ConnectorDefinitions.setEnabled` is not in the `serial()`
  queue, so it can interleave with a reload or a save inside the runtime. The panel copes
  (it lists the folder again after overlapping changes), but the runtime should serialise it.

## Operator guide text

For the integrator to replace the first paragraph of "Your own sources (connector
definitions)" in `docs/OPERATOR-GUIDE.md` with:

> A feed that publishes JSON, GeoJSON or CSV over HTTPS, or JSON over a WebSocket, can be
> added without a release. Settings → Sources → Definitions shows your definition folder
> (`%APPDATA%\WorldView\connectors\`, one `.json` per source) and every file in it, with
> the files shipped with the application below yours. **Add source** takes the https
> address of a sample, fetches it once and drafts a definition — the id, position, time and
> fields it recognised — and shows whether it validates and what is still to decide (the
> attribution and terms, above all). **Save to folder** writes it, off. Finish the file in
> your own editor (**Open folder**), then **Reload**: new files start, changed ones restart,
> removed ones stop, without restarting the application. Switch a source on beside its file
> or in its own row. A file that does not validate is listed with the reasons; the other
> files still load. A source that comes from a definition shows its connector (`rest-json`,
> `geojson`, …) under its name, and its file in the row's details. Demo mode has no folder,
> so the section is not shown.

## Evidence

Run in the phase container at `a27f587`, 2026-09-24, on `origin/develop` @ `59d546d`, with
the local toolchain linked (`tools/dev/link-local-toolchain.sh`; `pnpm install` answers 403).

```
node tools/dev/typecheck.mjs                         exit 0 (tsconfig.json and tsconfig.renderer.json; shims in use)
node tools/dev/boundary-check.mjs                    [boundary-check] files=708 violations=0 → PASS
node tools/dev/run-tests.mjs                         tests 1182 · pass 1174 · fail 0 · skipped 8 (natives)
node --import tsx tools/license-audit/src/cli.ts     0 errors, 0 warnings → PASS
node --import tsx tools/dev/todo-report.mjs          [todo-report] files=626 markers=0
node tools/dev/stage-resources.mjs --check           up to date
node --import tsx tools/connector-validator/src/cli.ts --all    14 pass, 0 fail → PASS
node tools/dev/phase-check.mjs source-health-ui --base origin/develop
  [phase-check] phase=source-health-ui branch=phase/source-health-ui base=origin/develop (59d546db0b) files=11
     apps/desktop/src/renderer/dialogs/add-source-dialog.test.ts
     apps/desktop/src/renderer/dialogs/add-source-dialog.tsx
     apps/desktop/src/renderer/panels/sources-connector-badge.test.ts
     apps/desktop/src/renderer/panels/sources-connector-badge.tsx
     apps/desktop/src/renderer/panels/sources-definitions-model.ts
     apps/desktop/src/renderer/panels/sources-definitions.test.ts
     apps/desktop/src/renderer/panels/sources-definitions.tsx
     apps/desktop/src/renderer/panels/sources-panel.tsx
     apps/desktop/src/renderer/panels/sources-test-client.ts
     docs/roadmap/phases/changelog/source-health-ui.md
     docs/roadmap/phases/source-health-ui.md
  [phase-check] PASS
phase tests: sources-definitions.test.ts 17, sources-connector-badge.test.ts 4, add-source-dialog.test.ts 12 — all pass
```

No horizontal scroll, checked in Chromium (the container's, through Playwright; a scratch
script, not committed): the panel's server-rendered markup with an open definition row, a
long name, a long connector id and the Definitions section filled with a long Windows
folder path, unbroken file names and problem messages, under the real `tokens.css`,
`base.css`, the UI component styles and `shell.css`, at a rail 372 px and 300 px wide —
`.wv-panel__body` scrollWidth = clientWidth (371/371, 299/299) and no element with
`overflow-x: auto|scroll` wider than its box; the dialog body likewise (638/638).

Not verified here:

- **ESLint** (not installable in the container) — written for `prefer-const`,
  `no-unused-vars`, `no-useless-escape`, `rules-of-hooks`, `exhaustive-deps` and checked by
  hand and by the reviewer; the Windows gate runs it.
- **Prettier** — formatted and `--check`ed with Prettier **3.8.1** (the container's), not the
  gate's 3.9.8.
- **The packaged Windows build** — badge, folder, reload, enable, rejected reason and the
  add-source draft on a real folder and a real URL are the integrator's screenshots.
- Focus moves in the dialog (effects; no DOM in this suite) and `SourcesPanel`'s wiring of
  the section and dialog, which is exercised only through the pieces it composes.
- A real `sources.definitions.draft` against a live URL (the container's network is
  allow-listed); the dialog was tested with a scripted client and the demo client only.
