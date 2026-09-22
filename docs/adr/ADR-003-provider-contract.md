# ADR-003 — Provider contract and runtime isolation

Status: Accepted · 2026-09-21 · Packages: `@worldview/provider-sdk`, `@worldview/provider-runtime`, `@worldview/source-health`

## Decision

- A provider is `manifest + data policy + normalizer + fixtures + tests`. `ProviderManifest` carries capabilities, credentials (keys only), `RefreshPolicy`, mandatory `ProviderDataPolicy`, attribution, `commercialReview` and an `allowedHosts` allowlist.
- Providers reach the world only through `ProviderContext` (http, sockets, credentials.has, cache, settings, local access, hash, clock, logger). No direct fetch/fs/child_process/WebSocket.
- `ProviderHost` owns scheduling, timeouts, bounded retries, exponential backoff, host allowlists, client-side rate limiting, per-host circuit breakers (in the shared `HttpClient`), observation admission (schema-validated, providerId-checked, batch-capped) and health publication into `SourceHealthRegistry`. One provider failure never leaves its health entry.
- Malformed bodies are invalidated in the HTTP cache so they are never served as a stale fallback; last-good data lives in world state, which ages it by policy instead of re-serving it.
- 2026-09-21 amendment (runtime composition): secrets stay out of provider code in the two remaining shapes — `ProviderHttpRequest.credential.as` gained `'path'` (the provider builds a `{TOKEN}` placeholder URL and the `HttpClient` substitutes the percent-encoded secret into that path segment; NASA FIRMS uses it), and `ProviderSockets.open` gained `opts.credential`, whose resolved secret reaches the provider only as `ProviderSocketEvents.onOpen(ctx.secret)` for the handshake frame (AISStream uses it; the secret is never attached to the socket handle).
- The contract checklist (`pnpm provider:test <dir>`, 16 checks) is the completion definition; its JSON report is release evidence. The manifest's data policy must equal the legal registry record in `config/licenses/providers.json`.

## Consequences

Adding a provider touches `providers/<id>/` (+ fixtures, + registry record) only. UI and renderers never import providers (enforced by boundary tests).
