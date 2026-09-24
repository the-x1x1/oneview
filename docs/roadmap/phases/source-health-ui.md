# Phase `source-health-ui` — Sources and Source Health show connectors; the operator's folder in-app

Status: building · Branch: `phase/source-health-ui` · Target: 0.2.0 · Owner: session 017GsK (2026-09-24)

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
   switch and the source row's switch agree. `dialogs/add-source-dialog.tsx` — address
   (https, no credentials in it, checked before sending) → `sources.definitions.draft` →
   connector, verdict, errors, the drafter's to-do list and notes, the drafted JSON behind a
   disclosure, an editable id (the runtime's rule, and ids already used by a source or a file
   refused before sending) → `sources.definitions.save` → saved, disabled, with Open folder
   and Add another. A draft that does not validate cannot be saved. A draft answering after
   the dialog closed is dropped; a save that lands after it closed still updates the list.
   Every error code the amendment names reads as a sentence.
3. Tests with a scripted client (`panels/sources-test-client.ts`) and `DemoClient`:
   `panels/sources-definitions.test.ts` (13), `panels/sources-connector-badge.test.ts` (4),
   `dialogs/add-source-dialog.test.ts` (8). Each was checked against deliberately broken code
   (stale answers applied, the folder check removed, rejected files given a switch).
4. Operator guide text below.
5. Changelog fragment `docs/roadmap/phases/changelog/source-health-ui.md`.

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

(filled in at the end)
