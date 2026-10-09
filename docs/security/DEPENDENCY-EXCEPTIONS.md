# Accepted dependency advisories

`pnpm audit --audit-level high` fails CI, and that is deliberate: a high or critical
advisory in this tree should stop a release until someone has looked at it. This file is
the record of the ones we have looked at and accepted, and why.

CI's `dependency-audit` job decides on the plain `pnpm audit --audit-level high`, which
applies the ignore list; the `--json` report it also writes is evidence only, because with
`--json` pnpm (10.28) exits 1 whenever a high advisory is counted, accepted or not (seen
2026-09-23: an empty advisory list, "2 high (2 ignored)", exit 1).

An entry belongs here only when **no patched version exists**. If a fix is published, the
answer is to take the fix, not to add a line here. `pnpm.auditConfig.ignoreGhsas` in the
root `package.json` must list exactly the advisories documented below —
`tools/dev/product-boundary.test.ts` fails if the two drift apart, so an ignore cannot be
added without an explanation and an explanation cannot outlive its ignore.

Recorded 2026-10-04, after Electron 39.8.10 → 44.5.1 took the count from seven high
advisories (two of them the extract-zip pair accepted on 2026-09-22) to the one below.

## GHSA-ch52-4w7c-c8xp — http-cache-semantics hands a shared cache's zeroed entries to `max-stale`

**Patched version:** none. The advisory (published 2026-09-18) covers every release through
4.2.0, the latest, and records `<0.0.0` for the fix.

**How it reaches us:** `apps/desktop > electron-builder > @electron/get@3 > got@11 >
cacheable-request@7 > http-cache-semantics`, and the same chain under
`electron-builder-squirrel-windows`. electron-builder uses `@electron/get` while packaging, to
fetch the Electron binary it wraps when it is not already in the local cache. Electron 44's own
installer no longer uses this chain (`@electron/get@5`, without got).

**Why it is accepted:**

- It is not shipped. The chain is build tooling only; nothing in it is in the asar or beside
  it, and `pnpm sbom` and `packaging.test.ts` hold the line that only declared runtime
  dependencies are packaged. `pnpm audit --prod` does not see it.
- The flaw is in a **shared** cache that serves many users: an unauthenticated client sends
  an inflated `max-stale` to read an entry kept back from it, such as another user's
  `Set-Cookie`. Here there is one client, the packaging run on the operator's own machine,
  downloading public release archives from Electron's release server; there is no shared
  cache, no other user and no session cookie to read.
- There is nothing to upgrade to. Overriding `got` or `cacheable-request` to another major
  under electron-builder would put an untested resolution under the release build to answer
  an advisory whose conditions it never meets.

**When to revisit:** if http-cache-semantics publishes a fix (take it, with an override if
electron-builder has not caught up); if electron-builder moves to `@electron/get@4` or later;
or if anything shipped by WorldView starts depending on it. Check on every electron-builder
update.

## Resolved: the extract-zip pair, GHSA-jmr9-qjv8-65gv and GHSA-7pqw-9j4j-h8q3

Accepted on 2026-09-22 (no patched release; `electron > @electron/get@2 > extract-zip`, used
once at install to unpack the Electron binary). Electron 44 unpacks with its own
`@electron-internal/extract-zip`, the old package is out of the tree, and both are off the
ignore list since 2026-10-04.

## Fixed, not accepted: GHSA-p2f4-r6v6-j797 and GHSA-7g7r-gx96-252g

Recorded 2026-09-23. Two high advisories — `builder-util-runtime < 9.7.0` (a cross-origin
redirect leaks `PRIVATE-TOKEN` / `Authorization`) and `app-builder-lib < 26.15.0` (an
AppImage search path) — reached the tree through `electron-builder-squirrel-windows@25.1.8`,
an optional peer of `app-builder-lib` that pnpm had auto-installed when electron-builder was
25 and kept after it went to 26.15.3 (it warned: "unmet peer … found 25.1.8"). WorldView
builds nsis and zip targets and never runs Squirrel, but a patched version exists, so the
answer was the fix. A `pnpm.overrides` entry did not do it — pnpm kept the auto-installed
peer's old resolution — so `apps/desktop` declares the peer itself,
`electron-builder-squirrel-windows@^26.15.3`, in step with `electron-builder`: its
`app-builder-lib` 26.15.3 carries `builder-util-runtime` 9.7.0, and the 25.1.8 chain is gone.
Keep the two on the same version when either is bumped. The new chain brings
`electron-winstaller@5.4.0`, whose install script pnpm does not run (it is not in
`onlyBuiltDependencies`; nothing here builds a Squirrel installer). Approved by the operator
(directive §141); the lockfile was regenerated on the operator machine with registry
access. Nothing is added to `ignoreGhsas`.

## Fixed, not accepted: GHSA-p98j-92pf-mc4p

Recorded 2026-09-30. A low advisory in `dompurify` 3.4.13–3.4.15 (with `IN_PLACE: true` and a
node-removing `afterSanitize*` hook, event handlers on a removed element's descendants stay
armed) reached the shipped renderer as `@cesium/engine > dompurify@3.4.15` and failed the
Windows gate's `pnpm audit --prod` on the 0.1.13 release merge. 3.4.16 fixes it, so the root
`package.json` overrides `dompurify` to `^3.4.16` (same package, same licence,
`MPL-2.0 OR Apache-2.0`); nothing is added to `ignoreGhsas`. Drop the override once
`@cesium/engine` itself requires 3.4.16 or later.

## Fixed, not accepted: GHSA-68fv-2mgg-jv7q

Recorded 2026-10-09. A high advisory in `source-map-js` < 1.2.2 (indexed source-map section
offsets can stall the event loop) failed the `dependency-audit` job on the
`feature/linux-cyberdeck-readiness` CI run 37909198100; the advisory was published after
v0.2.2, and the path is the same on `develop`: `apps/desktop > vite > postcss >
source-map-js@1.2.1`. It is build-time only (Vite's CSS pipeline; nothing of it ships in the
app). 1.2.2 fixes it, so the root `package.json` overrides `source-map-js` to `>=1.2.2` (same
package, same licence, BSD-3-Clause; `postcss` asks for `^1.2.1`); nothing is added to
`ignoreGhsas`. Drop the override once `postcss` requires 1.2.2 or later.

The same run reported a moderate advisory below the gate's threshold,
GHSA-hp3w-g68c-fv3c (`sprintf-js` ≤ 1.1.3, unbounded precision specifiers), on
`electron-builder > app-builder-lib > @electron/get > global-agent > roarr > sprintf-js`:
packaging-time only, with no patched version published. Not ignored (it does not fail the
gate); noted so the next look starts here.
