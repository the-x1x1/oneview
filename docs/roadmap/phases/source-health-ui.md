# Phase `source-health-ui` — Sources and Source Health show connectors; the operator's folder in-app

Status: open · Branch: `phase/source-health-ui` · Target: 0.2.0 · Owner: (unassigned)

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

- [ ] renderer tests green; typecheck (renderer program) green
- [ ] verified on the packaged Windows build: badge, folder, reload, enable, rejected reason,
      add-source draft
- [ ] `phase-check` passes; all common checks green

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

(the phase writes the section here)

## Evidence

(filled in at the end)
