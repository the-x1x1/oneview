# Security policy

## Reporting a vulnerability

Report privately through GitHub Security Advisories:
<https://github.com/the-x1x1/oneview/security/advisories/new>. Please do not open a
public issue for a vulnerability.

Include what you did, what happened, the WorldView version (Help → Diagnostics) and, if
you have one, a minimal reproduction. A redacted diagnostics bundle helps; check it
before attaching — it is redacted automatically, but you know your own environment.

Expect an acknowledgement within a few days. Fixes ship in the next release; a fix for a
high-severity issue ships as a patch release. Credit is given in the changelog unless
you prefer otherwise.

## Supported versions

WORLDVIEW is pre-1.0. Only the latest release on each channel (`stable`, `prerelease`)
receives fixes.

## What is in scope

- The desktop application: main process, preload bridge, renderer shell.
- The provider runtime and the network layer (allowlists, timeouts, size caps).
- The camera gateway and its loopback relay.
- Worldpack import (archive handling, path safety, integrity).
- Credential storage and log/diagnostics redaction.
- The updater and release provenance.

## What is not a vulnerability

- Data being wrong or missing because an upstream source is wrong or unavailable.
  WORLDVIEW shows source health and provenance; it does not vouch for third-party data.
- A user deliberately pointing a "camera" at a service on their own machine — the relay
  is loopback-only and serves only what the user registered.
- Findings that require an already-compromised Windows account.
- Missing code signing on development and release-candidate builds: this is a known,
  documented limitation (`docs/releases/KNOWN-LIMITATIONS.md`, ADR-012), and it is why
  automatic installation stays disabled.

## Hardening summary

`contextIsolation` on, `nodeIntegration` off, `sandbox` on, strict CSP, navigation and
window-open locked down, all permissions denied by default; an allowlisted, schema-
validated IPC catalogue with no generic execute/read/fetch channel; per-provider host
allowlists with timeouts, size caps, retries, circuit breakers and rate limits;
credentials in OS-protected storage, never readable by the renderer; central redaction
for logs and diagnostics; worldpacks validated against zip-slip, symlinks, executables,
bombs and tampering before anything is written.

The full analysis, with the test that verifies each mitigation, is in
[`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md).

`pnpm audit --audit-level high` runs in CI and fails the build. Where an advisory has no
patched version and we have accepted it, the reasoning is recorded in
[`docs/security/DEPENDENCY-EXCEPTIONS.md`](docs/security/DEPENDENCY-EXCEPTIONS.md); a test
fails if that file and the ignore list in `package.json` ever disagree, so nothing can be
silenced without a written justification.
