# ADR-012 — Update trust model

Status: Accepted · 2026-09-21 · Package: `@worldview/updater`

## Decision

Updates flow GitHub Release → signed metadata (`latest.yml`) → download → signature/hash verification → install on restart. Until a Windows code-signing certificate is configured (`SIGNING_REQUIRED` blocker), builds are unsigned: the updater only checks, displays availability and lets the user install a test build manually; background download/auto-install is enabled by configuration once signing exists. Channels: `stable` and `prerelease` (opt-in); a prerelease can never replace a stable install unless the user opted in. No OS security setting is weakened to simulate silent updates.
