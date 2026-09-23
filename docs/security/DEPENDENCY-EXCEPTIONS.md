# Accepted dependency advisories

`pnpm audit --audit-level high` fails CI, and that is deliberate: a high or critical
advisory in this tree should stop a release until someone has looked at it. This file is
the record of the ones we have looked at and accepted, and why.

An entry belongs here only when **no patched version exists**. If a fix is published, the
answer is to take the fix, not to add a line here. `pnpm.auditConfig.ignoreGhsas` in the
root `package.json` must list exactly the advisories documented below —
`tools/dev/product-boundary.test.ts` fails if the two drift apart, so an ignore cannot be
added without an explanation and an explanation cannot outlive its ignore.

Recorded 2026-09-22, after Electron 33 → 39.8.10, maplibre-gl 5 → 6.10.0, a
`tar >= 7.5.19` override and electron-builder 25 → 26.15.3 took the count from 50
advisories to the two below.

## GHSA-jmr9-qjv8-65gv — extract-zip unvalidated symlink path traversal

## GHSA-7pqw-9j4j-h8q3 — extract-zip arbitrary file writes through path traversal

Both are the same package and the same reasoning.

**Patched version:** none. The advisory records `<0.0.0`, which is npm's way of saying the
maintainers have published no fix and the package is unmaintained.

**How it reaches us:** `apps/desktop > electron > extract-zip`. Electron's own installer
(`@electron/get`) uses it once, during `pnpm install`, to unpack the Electron binary
archive it just downloaded from Electron's release server.

**Why it is accepted:**

- It is not shipped. extract-zip is a devDependency of a devDependency and appears nowhere
  in the packaged application — neither in the asar nor beside it. `pnpm sbom` and
  `packaging.test.ts` both hold the line that only declared runtime dependencies are
  packaged.
- It never processes untrusted input in this project. The only archive it opens is the
  one Electron's installer fetched over HTTPS from Electron's own release server, with an
  integrity check. An attacker who could substitute that archive has already won without
  needing a symlink.
- There is nothing to upgrade to. Overriding it would mean pointing Electron's installer
  at a fork, which trades a documented, bounded, build-time exposure for an undocumented
  supply-chain dependency of our own choosing.

**When to revisit:** if extract-zip ever ships a patched release; if Electron replaces it;
or if anything in this repository starts using it to open an archive that did not come
from Electron's release server. Check on every Electron major.

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
