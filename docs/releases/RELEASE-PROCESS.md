# Release process

## Branch model

```
feature/*  ─┐
fix/*      ─┴─► develop ──► release/x.y.z ──► human QA ──► main ──► tag vx.y.z ──► GitHub Release
```

- `main` — released, promoted only after human QA approval.
- `develop` — integration branch; every workstream merges here and must stay green.
- `release/x.y.z` — cut from `develop` when scope is complete; only fixes land on it.
- No feature branch commits directly to `main`.

## Version numbers until 0.2.0

From 2026-09-24 the operator asked for plain patch numbers instead of release candidates:
`0.1.6`, then `0.1.7`, and so on, until they say to move to `0.2.0`. Each is cut from
`develop` on a `release/0.1.x` branch (version in `apps/desktop/package.json` and the root
`package.json`, CHANGELOG `[Unreleased]` moved under the version, known limitations
updated), merged back into `develop`, gated on Windows, tagged `v0.1.x` on that merge and
published as a GitHub **prerelease** until the installer QA below has been done. `main`
stays where it is until a human approves promoting one.

## Cutting a release candidate

1. `git checkout develop && git pull` — confirm CI is green.
2. `git checkout -b release/0.1.0` and set the version in `apps/desktop/package.json`.
3. Update `CHANGELOG.md` (move Unreleased into the version) and
   `docs/releases/KNOWN-LIMITATIONS.md`.
4. On a Windows machine with the toolchain installed:

```powershell
corepack enable; corepack prepare pnpm@10.28.0 --activate
pnpm install --frozen-lockfile
pnpm stage:resources -- --check
pnpm typecheck
pnpm boundary-check
pnpm test                    # unit + contract + integration + offline + failure
pnpm provider:test --all     # per-provider contract checklists
pnpm license-audit
pnpm todo-report
pnpm run doctor
pnpm build
pnpm release:package         # empties apps/desktop/release/ and artifacts/release/, builds, packs
pnpm sbom                    # after packaging: packaging empties artifacts/release/
pnpm release:verify          # → artifacts/release/verification-report.json + SHA256SUMS.txt
pnpm release:assert-version  # every artifact is this version and this commit
```

5. `pnpm release:verify` must print `Release gate → PASS`. It also prints what was _not_
   verified in that environment — read it; an RC handed over with unverified claims is
   worse than a late one.
   5a. `pnpm release:assert-version` must print `PASS`. It fails if the tag is not
   `v<apps/desktop version>`, if an installer, zip, blockmap or SBOM of any other version is
   in the release directories, if `latest.yml`, the SBOM or the verification report names
   another version or commit, or if the report was written before packaging (it does not
   hash this version's installer). rc.4 was published with rc.3's installer, zip and SBOM
   beside its own because nothing emptied the output directories and the assets were picked
   with globs; `release:package` now empties both first and stops if it cannot, and assets
   are uploaded **by exact name** — the ones listed in "Release assets" below, with the
   version in them — never `*.exe`.
6. Tag the candidate (`git tag v0.1.0-rc.1 && git push --tags`) or run the
   **Build desktop** workflow manually. Either way the workflow produces a **draft**
   prerelease; nothing is published automatically.

## Human QA

Run the checklist for the version on real Windows 10/11 x64 hardware, against the
installed build: `docs/releases/QA-CHECKLIST-0.1.0.md` for the 0.1.x line, and
`docs/releases/QA-CHECKLIST-0.2.0.md` for 0.2.0. Every box is either ticked or has an issue
number next to it (the 0.2.0 checklist also allows "n/a" with a reason for weather that is
not happening that day).

### What gates 0.2.0

0.2.0 is not cut on a date (ROADMAP.md, "0.2.0 ships only when the picture is complete").
It is tagged only when:

1. every item of the ROADMAP's 0.2.0 bar is met, including the refactor pass in
   `docs/roadmap/INTEGRATION.md`;
2. the Windows gate (`check.bat`) is green on the release commit and
   `pnpm release:assert-version` prints `PASS`;
3. `docs/releases/QA-CHECKLIST-0.2.0.md` has been walked on the installed build on the
   reference laptop (Radeon 740M, 1920×1200), with every **(blocking)** item and every item
   in a blocking section ticked, its evidence (screenshots, `app.log` lines, Diagnostics
   exports) filed beside it, and the checklist's own "0.2.0 bar" section ticked; and
4. `docs/releases/KNOWN-LIMITATIONS.md` for 0.2.0 holds nothing an operator would call
   broken.

Until then the work ships as 0.1.x patch releases.

QA failures follow the loop in the
directive: reproduce → issue → fix on the release branch → rerun the automated gate →
produce RC(n+1) → focused retest.

Blocking failures never merge to `main`.

## Promotion

Only after explicit human approval:

1. Open a PR from `release/x.y.z` to `main`; the PR body links the verification report
   and the completed QA checklist.
2. Merge, then tag `vx.y.z` on `main`.
3. The Build desktop workflow attaches the artifacts to a draft release; a human
   publishes it after checking the hashes in `SHA256SUMS.txt` against the uploaded files.
4. Merge `main` back into `develop`.

## Release assets

`WorldView-Setup-x.y.z.exe`, `WorldView-Portable-x.y.z.zip`, `SHA256SUMS.txt`,
`THIRD_PARTY_NOTICES.txt`, `WorldView-x.y.z.sbom.json`, `verification-report.json`, and
`latest.yml` (updater metadata) once the channel is live.

## Signing

Until a Windows code-signing certificate is configured, releases are unsigned: the
updater checks and notifies but never installs on its own, and SmartScreen warns on
first run. When the certificate exists, set the signing fields in
`apps/desktop/electron-builder.yml`, enable background download in the updater policy,
and remove the SIGNING_REQUIRED entry from the known limitations. No OS security control
is weakened in the meantime (ADR-012).
