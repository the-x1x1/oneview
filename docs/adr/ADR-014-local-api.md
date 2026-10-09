# ADR-014 — Local read-only API

Status: Accepted · 2026-10-08 · Package: `@worldview/runtime` (`support/local-api.ts`), types in
`@worldview/ipc-contract` (`local-api.ts`) · docs/cyberdeck M6

## Context

A separate program on the same computer — Formicaria, later — should be able to read what a
running WORLDVIEW knows: which sources are up, objects near a place, a track, offline status, and
(with the operator's say-so) this computer's own GPS position. WORLDVIEW must stay a standalone
app: no Formicaria code, model runtime or dependency inside it, and nothing that turns it into a
service for the network.

The existing IPC contract (`ipc-contract`, served over Electron IPC to the renderer) is not that
interface: it includes operator-only actions (settings, enabling sources, installing packs,
exports) and is shaped for one trusted renderer. Exposing it, or a subset filtered by name,
would make every future channel a question of whether it leaks.

## Decision

- **A separate, narrow, versioned API.** HTTP/1.1, `GET` only, JSON answers, paths under `/v1`:
  `/v1`, `/v1/health`, `/v1/sources`, `/v1/objects`, `/v1/track`, `/v1/offline`,
  `/v1/own-position`. Its own router (`handleLocalApi`) over read-only views of the runtime —
  not the IPC handlers by name. A new endpoint is a code change with tests, never a
  configuration.
- **A Unix socket that only this user can open.** `$XDG_RUNTIME_DIR/worldview/api.sock`: the
  per-user runtime folder the login session creates (0700, tmpfs). That folder must be ours and
  not writable by others; the `worldview` folder in it is created 0700 and must be ours and not a
  link; the socket is made under a 0177 umask (for the one synchronous `listen` call only) and
  set 0600. A path that is not our socket (a file, a link, another user's), or a socket something
  still answers on (another WORLDVIEW), is refused and left alone; on stop and on quit only the
  socket this server made (by inode) is removed. No `XDG_RUNTIME_DIR`, no API. No TCP listener
  of any kind, so nothing on the network — loopback included — can reach it. This is the same
  trust model as `ssh-agent`'s socket: the kernel's file permissions are the credential. No
  token is generated: a token would have to be stored in plaintext for the consumer to read,
  which the cyberdeck spec rules out, and would add nothing over the socket's permissions
  against the only users who could reach it.
- **Linux only, off by default.** `settings.localApi.enabled` (Settings → Local API, shown on
  Linux). `settings.localApi.ownPosition` is a second, separate permission. On Windows the API is
  not offered; a named pipe with an equivalent ACL is the way to add it if wanted.
- **Data policy in the server.** An object is listed only if every source behind it has a data
  policy with `exportAllowed: true`; an unknown source fails closed. "Behind it" is its
  provenance, its source refs, and every provider that has fed it while in the world
  (`WorldState.contributors`): refs are capped at eight and a provider's merged labels outlive
  its ref. A track additionally needs `normalizedRetentionAllowed`, from every provider with
  points in the stored history for the range as well. `meshtastic-local` (other people's
  positions) has `exportAllowed: false` and is never listed. Objects left out leave no trace —
  no count, which under a query's filters would say where they are; `/v1/sources` gives a closed
  source's state but not its size or last activity. Vault answers give labels and states, not
  mount paths.
- **Own position is its own permission**, read from the source that reports it
  (`ProviderHealth.ownPosition`, the Meshtastic node plugged in by USB) — coordinates only with a
  fix (or an old fix, said to be stale; or a position set by hand, said so); NO FIX answers no
  coordinates.
- **Bounded.** No request body (413/405, the body never read); URL ≤ 2,048 bytes; known
  parameters only, each once, validated; objects ≤ 500 a page (default 100) with a stable
  id-ordered cursor; radius ≤ 500 km; tracks ≤ 24 h and ≤ 5,000 points; answers ≤ 4 MiB; 5 s
  request and header timeouts, checked every second; at most 8 connections; 120 requests a minute (429).
- **Contract fixtures** (`fixtures/local-api/v1/*.json`) are the router's answers to an
  invented world and a test keeps them current; `tools/local-api-client/consumer.mjs` is a
  dependency-free example consumer.

## Consequences

- Formicaria can be built against `/v1` and the fixtures without WORLDVIEW knowing about it.
- Live state only: `/v1/objects` answers what the app holds now (`basis: 'live'`), and in demo
  mode says `recorded: true`. Historical object queries beyond one object's track are not in v1.
- Any user able to run code as the operator can read what the operator has allowed — as with any
  file in their home. The API adds no access beyond that, and none for other users or the
  network.
- Changing an answer's shape is a version change (`/v2`), with v1 kept or retired by a decision.
