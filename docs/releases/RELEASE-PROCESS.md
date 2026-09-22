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
pnpm release:package         # → apps/desktop/release/
pnpm sbom
pnpm release:verify          # → artifacts/release/verification-report.json + SHA256SUMS.txt
```

5. `pnpm release:verify` must print `Release gate → PASS`. It also prints what was _not_
   verified in that environment — read it; an RC handed over with unverified claims is
   worse than a late one.
6. Tag the candidate (`git tag v0.1.0-rc.1 && git push --tags`) or run the
   **Build desktop** workflow manually. Either way the workflow produces a **draft**
   prerelease; nothing is published automatically.

## Human QA

Run `docs/releases/QA-CHECKLIST-0.1.0.md` on real Windows 10/11 x64 hardware. Every box
is either ticked or has an issue number next to it. QA failures follow the loop in the
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
