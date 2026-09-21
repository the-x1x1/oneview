# WORLDVIEW threat model

Scope: the WORLDVIEW desktop application (Electron main, preload, renderer), the
provider runtime that reaches external data sources, the local data it stores, the
optional local sidecars, and the release/update path. Release 0.1.0-rc.1.

The application is local-first and account-free. There is no WORLDVIEW server: the
"backend" is the user's own machine. That shapes the model — most assets are local
(user data, credentials, history) and most untrusted input arrives as data from
third-party feeds, files the user imports, or cameras the user configures.

## Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Provider credentials (FIRMS MAP_KEY, AISStream key, camera passwords, ion/Google tokens) | `credentials.json`, encrypted with Electron `safeStorage` (DPAPI on Windows) | Theft gives an attacker the user's paid/limited quota and, for cameras, access to their own devices |
| User data: collections, watch zones, settings, lenses | `%APPDATA%/WorldView/*.json`, atomic writes | Loss or corruption destroys the user's work; watch zones reveal what they care about |
| Observation history | `%APPDATA%/WorldView/history/**` (Parquet/NDJSON) | Shows where the user has been looking, and when |
| The rendering/ingest process itself | Electron renderer + main | A renderer compromise is the gateway to everything above |
| Release artifacts and update metadata | GitHub Releases | Compromise here reaches every installation |

## Trust boundaries

1. **Third-party feed → provider.** Every byte from USGS, CelesTrak, FIRMS, NWS,
   adsb.lol, AISStream, camera catalogs and public frame hosts is untrusted.
2. **User-supplied file → application.** `.worldpack` archives, imported collections,
   camera URLs and local readsb endpoints.
3. **Renderer → main.** The renderer is treated as the least trusted part of the app:
   it renders remote-derived content and runs third-party rendering libraries.
4. **Local sidecar → application.** go2rtc and readsb are separate processes on
   loopback.
5. **Build/release → installation.** The updater's trust in GitHub Releases.

## Threats and mitigations

Each row names the code that mitigates it and the test that proves the mitigation.
"Residual" states what is *not* handled in 0.1.0.

### T1 Malicious or malformed provider JSON/CSV

*Threat:* a compromised or buggy feed returns hostile payloads (huge arrays, NaN
coordinates, prototype-polluting keys, HTML error pages) to crash the app, poison the
world model, or blow up memory.

*Mitigation:* every provider normalizes into `Observation` and the runtime admits
batches only through `observationSchema` (`packages/world-model/src/validate.ts`,
`admitObservations` in `provider-sdk/src/helpers.ts`): non-finite numbers, non-JSON
values, out-of-range coordinates and unknown object types are rejected per row, and a
non-empty feed that yields zero valid rows is treated as malformed rather than
replacing good state (`assertAtomicAdmission`). Batches are capped
(`ProviderHostDeps.maxBatch`, default 250k). Responses are size-capped and
streamed (`HttpClient.readCapped`), and a body that fails to parse is invalidated so it
can never be re-served as a stale fallback (`ProviderHttpResponse.invalidate`).

*Verification:* the "Malformed Feed" and "Normalization" checks of the provider
checklist (all 10 providers, `pnpm provider:test`); `http: size cap is enforced on
streamed bodies`;
`observation schema accepts a valid USGS-style observation and rejects malformed ones`.

*Residual:* a feed that returns *plausible but wrong* data (a real earthquake at the
wrong coordinates) is indistinguishable from good data; provenance and source health
are the user's only signal.

### T2 Compromised provider endpoint / hostile redirect

*Threat:* DNS hijack or a compromised host redirects a provider request to an attacker
endpoint, or serves an enormous/slow response to wedge the app.

*Mitigation:* per-provider host allowlist from `manifest.allowedHosts`, enforced in
`HttpClient.isHostAllowed`; HTTPS only (plain HTTP is permitted to loopback only);
`redirect: 'manual'` — a redirect is an error, never followed; per-request timeout,
bounded retries with backoff, per-host circuit breaker and client rate limiting.

*Verification:* `http: rejects hosts outside the allowlist and non-https schemes`;
`http: retries 5xx with backoff, gives up after maxRetries, opens circuit, serves stale
within window`; `http: timeout and cancellation are classified`.

*Residual:* TLS trust is the OS store's; WORLDVIEW does not pin certificates.

### T3 Cross-site scripting / untrusted content in the renderer

*Threat:* provider text (place names, alert headlines, camera titles) or a map style
reaches the DOM as markup and executes.

*Mitigation:* React escapes text by default and the shell never uses
`dangerouslySetInnerHTML`; a strict CSP is set on the default session
(`apps/desktop/src/main/csp.ts`): `default-src 'self'`, `script-src 'self'`,
`object-src 'none'`, `frame-src 'none'`, no `unsafe-eval`; navigation is locked to the
bundled `index.html` (or the Vite dev origin), `setWindowOpenHandler` denies all window
opens, and every permission request is denied.

*Verification:* `csp: production policy is strict; dev adds only the Vite origin`;
`renderer origin lock: only the bundled index or the dev server`.

*Residual:* `style-src` allows `'unsafe-inline'` because Cesium and MapLibre inject
inline styles; CSS injection through a style value remains theoretically possible.

### T4 Untrusted camera URLs

*Threat:* a camera URL is used to probe the local network (SSRF), to exfiltrate
credentials, or to point the relay at itself (amplification).

*Mitigation:* the gateway validates schemes and strips embedded credentials into
`safeStorage` at registration (`packages/camera-gateway/src/direct-gateway.ts`); the
relay binds to `127.0.0.1` on a random port, serves only registered camera ids with a
per-camera token, refuses self-referential targets, caps concurrent streams, verifies
that bodies are media, and rewrites HLS playlists so segment references cannot escape
the registered directory. Public catalog frames may only come from the pack's
registered frame host. Nothing in the camera path recognises, classifies or retains
image content (`docs/PRODUCT-BOUNDARIES.md`).

*Verification:* `relay binds to 127.0.0.1 on a random port and answers 404 for unknown
ids and wrong tokens`; `relay refuses a camera that points at itself`; `relay streams a
fake MJPEG upstream with credential injection and never logs the header`; `relay
rewrites HLS playlists to relay paths and refuses references outside the registered
directory`; `failure: upstream 500 / timeout / non-image surface as typed errors…`.

*Residual:* a user who deliberately registers an internal HTTP service as a "camera"
can view it through the relay — that is their own machine and their own choice, but it
means the relay must never be exposed beyond loopback.

### T5 IPC abuse from a compromised renderer

*Threat:* renderer code reaches main-process capabilities: arbitrary file reads,
process spawning, credential extraction.

*Mitigation:* `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the
preload exposes only `request(channel, payload)` and `on(event)` over an allowlist
derived from `REQUEST_CHANNELS`/`EVENT_CHANNELS` (`apps/desktop/src/preload/allowlist.ts`);
the router registers exactly those channels, validates every payload against a
per-channel schema (`ipc-schemas.ts`), refuses untrusted senders before validation,
rate-limits `credentials.*`, and maps errors to `IpcError` without stacks, paths or
secrets. There is no `execute`, `readFile` or `request(url)` channel. `credentials.get`
does not exist: the renderer can set, delete and ask *whether* a key is present.

*Verification:* `router: registers exactly the request catalogue and nothing else;
unknown channels are refused`; `router: every channel rejects a malformed payload…`;
`router: untrusted senders are refused before validation or handlers run`;
`router: credentials.* is rate limited to 10 per minute per window`;
`router: errors are mapped to IpcError without stacks, paths or secrets`;
`preload allowlist: only catalogue channels get a wire name`;
`credential store: round trip with encryption; file never contains plaintext; renderer-visible has() only`.

*Residual:* a renderer compromise can still drive any legitimate capability (install a
pack the user has on disk, register a camera). The blast radius is the app's own
allowlisted surface.

### T6 Malicious `.worldpack`

*Threat:* an imported pack escapes its directory (zip-slip), exhausts disk (zip bomb),
plants executables, or claims data it does not contain.

*Mitigation:* `packages/offline/src/zip.ts` validates before extracting anything:
normalised names only (no absolute paths, `..`, backslashes or drive letters), no
symlink attributes, no executable extensions, no duplicates (case-insensitive), no
entries missing from the manifest and no manifest entries missing from the archive,
per-entry and total size caps, compression-ratio bomb check, CRC32 + SHA-256 verified
against the manifest, zip64/encryption/unknown methods refused. Extraction goes to a
staging directory and is renamed into place atomically; a failed import leaves nothing
behind. A pack contains data only — it can never contain code.

*Verification:* the fourteen `zip:`/`adversarial:` tests in
`packages/offline/src/zip.test.ts`; `registry: a tampered pack is refused and leaves
nothing behind; reinstall replaces atomically`.

*Residual:* packs are integrity-checked but **not signed** — a pack is only as
trustworthy as where the user got it. Signing is Release 2 (ADR-012).

### T7 Path traversal in user data and exports

*Threat:* a provider id, pack id, camera id or collection name containing `../`
escapes the data directory.

*Mitigation:* all user-data paths are composed through `packages/config/src/data-dirs.ts`,
which validates that the resolved path stays inside its root; ids are constrained by
the identifier grammar (`packages/world-model/src/identifiers.ts`); file dialogs are
main-process only (`HostBridge`), so the renderer never chooses a path.

*Verification:* `data dirs: isInsideDir rejects traversal and absolute escapes`.

*Residual:* a user who points an export at a directory they should not write to is
exercising their own permissions; WORLDVIEW constrains its own data directory, not the
account's reach.

### T8 Local sidecar exposure and localhost CSRF

*Threat:* go2rtc's API or the camera relay is reachable from the network or from a web
page the user visits (a browser can POST to `http://127.0.0.1:…`).

*Mitigation:* the sidecar config generated by `Go2rtcSidecar` binds the API to
`127.0.0.1:1984` and RTSP to `127.0.0.1:8554` only, and the sidecar is started only
when the user configures a binary path; the relay binds to loopback on a random port
and requires an unguessable per-camera token in the path, which a cross-site request
cannot know. The relay exposes no camera listing and no mutating endpoints, so a blind
cross-site POST achieves nothing.

*Verification:* `relay binds to 127.0.0.1 on a random port and answers 404 for unknown
ids and wrong tokens`; the go2rtc config-generation tests assert loopback-only binds
and that an absent binary means the sidecar never starts.

*Residual:* another local process running as the user can read the relay token from
the process list/memory; local-user isolation is the OS's job.

### T9 Update compromise

*Threat:* a hostile update replaces the application.

*Mitigation:* updates come from GitHub Releases with electron-updater metadata and are
hash-verified; **automatic installation stays disabled until Windows code signing is
configured** — unsigned builds only check and notify, and the user installs manually
(`packages/updater`, ADR-012). A prerelease never replaces a stable install unless the
user opted into the prerelease channel. No OS security control is weakened to make
silent updates work.

*Verification:* the updater policy matrix tests (signed/unsigned × channel × automatic)
in `packages/updater`.

*Residual:* until signing exists, the trust anchor is TLS to GitHub plus the hash in
the release metadata — sufficient against tampering in transit, not against a
compromised release account. Publishing requires a human (`docs/releases/RELEASE-PROCESS.md`).

### T10 Supply-chain / plugin compromise

*Threat:* a malicious npm dependency, or a third-party "provider plugin", runs inside
the app.

*Mitigation:* pinned package manager and lockfile; `pnpm audit` in CI at
high/critical; Dependabot proposes updates but nothing auto-merges; an SBOM is
generated for every release; **no runtime plugin loading exists** — the provider
registry is compiled in, and third-party provider installation is explicitly deferred
until signing, permissions and process isolation exist (directive §128).

*Verification:* CI jobs `dependency-audit`, `sbom`, `license-audit`;
`registry: every key is a unique manifest id with a valid manifest and a fresh instance per call` and `registry: every shipped provider has a legal registry record whose dataPolicy matches its manifest`.

*Residual:* a compromised dependency still runs with the app's privileges. Electron's
sandbox limits the renderer, not the main process.

### T11 Sensitive data in logs and diagnostics

*Threat:* an API key, camera password or authorization header ends up in a log file or
in a diagnostics bundle the user posts to an issue.

*Mitigation:* redaction happens once, centrally, in `packages/core/src/logger.ts`
(`redactText`/`redactFields`: key-like field names, query-string secrets, bearer
tokens, `user:pass@` URLs) and again when a diagnostics bundle is built
(`packages/diagnostics/src/redact.ts`), which also replaces the user's home directory
with `~`. Provider errors are sanitised at the source (`ProviderError.toInfo`).
The relay never logs injected credential headers.

*Verification:* `logger redacts secrets in messages and fields`;
`http: credential injected by key, never exposed in errors…`;
`relay streams a fake MJPEG upstream with credential injection and never logs the header`;
the diagnostics redaction tests.

*Residual:* a provider that embeds a secret in an unusual place (a response body echoed
into a message) could evade the patterns; the bundle is the user's to review before
sharing, and the issue template says so.

### T12 Malicious imported collection

*Threat:* a shared collection file carries hostile strings (script, huge payloads) or
references that drive the app somewhere unexpected.

*Mitigation:* imports are schema-validated before anything is stored; strings are
length-bounded; the renderer treats all of it as text. Import is initiated through a
main-process file dialog, never a renderer path.

*Verification:* `integration: collections and lenses round-trip through the host bridge
and survive a restart`; the settings/user-document validation tests.

*Residual:* a collection that validates can still describe somewhere misleading — it is
the sender's claim about the world, shown as text, and WORLDVIEW does not vouch for it.

### T13 Denial of service through resource exhaustion

*Threat:* a feed with a million objects, or a worldpack that fills the disk, makes the
app unusable.

*Mitigation:* batch caps, per-type expiry in the state engine, bounded track and
recent-observation buffers, bounded event store, retention sweeps capped by data policy,
per-entry/total size limits on pack import, LOD and feature caps in the presentation
pipeline (a 50k-object local view updates in ~9 ms in-thread; above 5,000 objects the
work moves to a worker, so a larger set slows the map rather than the interface).

*Verification:* `spatial index: 100k objects bbox query stays fast`; the presentation
presentation benchmark (`pnpm benchmark`, recorded in the release verification report); `state: sweep
reclassifies freshness and expires by type policy…`.

*Residual:* the caps keep the application responsive, not the machine: history and
installed packs grow on disk until retention or the operator removes them, and a
sustained feed far above the benchmarked scale degrades to fewer visible features
rather than failing outright.

### T14 Misuse against a private individual

*Threat:* the product is turned into a tool for following a specific person.

*Mitigation:* this is a product boundary, not only a technical control
(`docs/PRODUCT-BOUNDARIES.md`): no named-person search, no facial recognition, no
plate databases, no private-device tracking, no camera-frame analysis; identity
resolution joins only on authoritative *object* identifiers (ADR-011), and the ALPR
layer inherited from upstream was removed. Feature requests are screened against this
boundary in the issue template. The shape of that boundary is checked mechanically by
`tools/dev/product-boundary.test.ts`, so a person-oriented capability cannot be added
without the build failing.

*Verification:* `boundary: identity resolution merges only on authoritative object
identifiers (ADR-011)`; `boundary: no channel searches for a person, and no recognition
runs on a frame`; `boundary: no module that handles frame bytes writes them to disk`;
`boundary: the document and the threat model still state the commitment`.

*Residual:* aircraft and vessel identifiers are public data that can be correlated with
ownership records outside WORLDVIEW. The boundary is about what this product builds,
not about what public data exists.

### T15 Tampered settings naming an arbitrary binary

*Threat:* `settings.json` is a plain file the user (or anything running as the user) can
edit. `cameras.go2rtcPath` tells the runtime which program to launch, so a rewritten
settings file could point it at something else.

*Mitigation:* the path crosses a trust boundary and is validated like any other input
(`appSettingsSchema`): it is either empty or absolute, never a bare name, so PATH and
the working directory are never consulted and a binary dropped beside the app cannot be
picked up by shadowing the expected name. The runtime spawns it directly with
`shell: false` and no inherited stdio, so the string is never interpreted by a shell,
and it is spawned only when an RTSP camera is actually added or opened — a machine with
no RTSP cameras never runs it regardless of the setting. Changing the path stops a
running process first, so a swap cannot leave the previous binary running under the new
label.

*Verification:* `go2rtc: settings reject a relative binary path`, `go2rtc: a configured
path that does not exist reports not-configured and never spawns`, `go2rtc: unconfigured
is the default — nothing is spawned and the status says so`, and `sidecar: changing the
binary path stops the running process before the swap`.

*Residual:* anything able to rewrite `settings.json` is already running as the user and
can execute code without WORLDVIEW's help, so this is hardening, not a privilege
boundary. WORLDVIEW checks that the configured binary exists and reports a version
mismatch against the pinned release, but does not verify its provenance — see
Assumptions.

## Conventions

A name in backticks on a *Verification:* line is the exact title of a test in this
repository, abbreviated with a trailing `…` when the full title is long.
`tools/dev/docs-claims.test.ts` checks every one of them against the suite, so a
renamed or deleted test fails the build rather than leaving a claim here that nothing
backs. Checklist checks and other non-test evidence are named in plain quotes.

## Assumptions

- The user's Windows account is not already compromised; `safeStorage` is only as
  strong as the OS account.
- The OS certificate store is intact.
- Sidecars the user installs (go2rtc, readsb) are the genuine builds — WORLDVIEW checks
  reachability, not provenance.

## Review triggers

Re-review this document when: a new IPC channel is added; a provider gains a new
transport; a setting gains the power to name an executable or a path the runtime acts
on; the camera relay or a sidecar changes; the worldpack format changes; the
updater gains automatic installation (after signing); or third-party provider loading
is introduced.
