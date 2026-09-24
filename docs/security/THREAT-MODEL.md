# WORLDVIEW threat model

Scope: the WORLDVIEW desktop application (Electron main, preload, renderer), the
provider runtime that reaches external data sources, the local data it stores, the
optional local sidecars, and the release/update path. Release 0.1.0-rc.1.

The application is local-first and account-free. There is no WORLDVIEW server: the
"backend" is the user's own machine. That shapes the model — most assets are local
(user data, credentials, history) and most untrusted input arrives as data from
third-party feeds, files the user imports, or cameras the user configures.

## Assets

| Asset                                                                                    | Where it lives                                                               | Why it matters                                                                                      |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Provider credentials (FIRMS MAP_KEY, AISStream key, camera passwords, ion/Google tokens) | `credentials.json`, encrypted with Electron `safeStorage` (DPAPI on Windows) | Theft gives an attacker the user's paid/limited quota and, for cameras, access to their own devices |
| User data: collections, watch zones, settings, lenses                                    | `%APPDATA%/WorldView/*.json`, atomic writes                                  | Loss or corruption destroys the user's work; watch zones reveal what they care about                |
| Observation history                                                                      | `%APPDATA%/WorldView/history/**` (Parquet/NDJSON)                            | Shows where the user has been looking, and when                                                     |
| The rendering/ingest process itself                                                      | Electron renderer + main                                                     | A renderer compromise is the gateway to everything above                                            |
| Release artifacts and update metadata                                                    | GitHub Releases                                                              | Compromise here reaches every installation                                                          |

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
"Residual" states what is _not_ handled in 0.1.0.

### T1 Malicious or malformed provider JSON/CSV

_Threat:_ a compromised or buggy feed returns hostile payloads (huge arrays, NaN
coordinates, prototype-polluting keys, HTML error pages) to crash the app, poison the
world model, or blow up memory.

_Mitigation:_ every provider normalizes into `Observation` and the runtime admits
batches only through `observationSchema` (`packages/world-model/src/validate.ts`,
`admitObservations` in `provider-sdk/src/helpers.ts`): non-finite numbers, non-JSON
values, out-of-range coordinates and unknown object types are rejected per row, and a
non-empty feed that yields zero valid rows is treated as malformed rather than
replacing good state (`assertAtomicAdmission`). Batches are capped
(`ProviderHostDeps.maxBatch`, default 250k). Responses are size-capped and
streamed (`HttpClient.readCapped`), and a body that fails to parse is invalidated so it
can never be re-served as a stale fallback (`ProviderHttpResponse.invalidate`).

_Verification:_ the "Malformed Feed" and "Normalization" checks of the provider
checklist (all 10 providers, `pnpm provider:test`); `http: size cap is enforced on
streamed bodies`;
`observation schema accepts a valid USGS-style observation and rejects malformed ones`.

_Residual:_ a feed that returns _plausible but wrong_ data (a real earthquake at the
wrong coordinates) is indistinguishable from good data; provenance and source health
are the user's only signal.

### T2 Compromised provider endpoint / hostile redirect

_Threat:_ DNS hijack or a compromised host redirects a provider request to an attacker
endpoint, or serves an enormous/slow response to wedge the app.

_Mitigation:_ per-provider host allowlist from `manifest.allowedHosts`, enforced in
`HttpClient.isHostAllowed`; HTTPS only (plain HTTP is permitted to loopback only);
`redirect: 'manual'` — a redirect is an error, never followed; per-request timeout,
bounded retries with backoff, per-host circuit breaker and client rate limiting.

_Verification:_ `http: rejects hosts outside the allowlist and non-https schemes`;
`http: retries 5xx with backoff, gives up after maxRetries, opens circuit, serves stale
within window`; `http: timeout and cancellation are classified`.

_Residual:_ TLS trust is the OS store's; WORLDVIEW does not pin certificates.

### T3 Cross-site scripting / untrusted content in the renderer

_Threat:_ provider text (place names, alert headlines, camera titles) or a map style
reaches the DOM as markup and executes.

_Mitigation:_ React escapes text by default and the shell never uses
`dangerouslySetInnerHTML`; a strict CSP is set on the default session
(`apps/desktop/src/main/csp.ts`): `default-src 'self'`, `script-src 'self'`,
`object-src 'none'`, `frame-src 'none'`, no `unsafe-eval`; navigation is locked to the
app's own origin (or the Vite dev origin), `setWindowOpenHandler` denies all window
opens, and every permission request is denied.

The packaged renderer is served over a registered scheme, `worldview://app`
(`apps/desktop/src/main/app-protocol.ts`), not from `file:`. That is what makes `'self'`
denote something specific; a `file:` document has an opaque origin, so `'self'` matches
nothing and the policy is both unenforceable and — because Vite emits `crossorigin`
module scripts — fatal to the application. The protocol handler resolves every request
inside `dist/renderer` and refuses anything else, which is the boundary that replaces the
old path check.

_Verification:_ `csp: production policy is strict; dev adds only the Vite origin`;
`renderer origin lock: only the app scheme or the dev server`;
`app protocol: serves the bundle, and nothing outside it`.

_Residual:_ `style-src` allows `'unsafe-inline'` because Cesium and MapLibre inject
inline styles; CSS injection through a style value remains theoretically possible.

### T4 Untrusted camera URLs

_Threat:_ a camera URL is used to probe the local network (SSRF), to exfiltrate
credentials, or to point the relay at itself (amplification).

_Mitigation:_ the gateway validates schemes and strips embedded credentials into
`safeStorage` at registration (`packages/camera-gateway/src/direct-gateway.ts`); the
relay binds to `127.0.0.1` on a random port, serves only registered camera ids with a
per-camera token, refuses self-referential targets, caps concurrent streams, verifies
that bodies are media, and rewrites HLS playlists so segment references cannot escape
the registered directory. Public catalog frames may only come from the pack's
registered frame host. Nothing in the camera path recognises, classifies or retains
image content (`docs/PRODUCT-BOUNDARIES.md`).

_Verification:_ `relay binds to 127.0.0.1 on a random port and answers 404 for unknown
ids and wrong tokens`; `relay refuses a camera that points at itself`; `relay streams a
fake MJPEG upstream with credential injection and never logs the header`; `relay
rewrites HLS playlists to relay paths and refuses references outside the registered
directory`; `failure: upstream 500 / timeout / non-image surface as typed errors…`.

_Residual:_ a user who deliberately registers an internal HTTP service as a "camera"
can view it through the relay — that is their own machine and their own choice, but it
means the relay must never be exposed beyond loopback.

### T5 IPC abuse from a compromised renderer

_Threat:_ renderer code reaches main-process capabilities: arbitrary file reads,
process spawning, credential extraction.

_Mitigation:_ `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the
preload exposes only `request(channel, payload)` and `on(event)` over an allowlist
derived from `REQUEST_CHANNELS`/`EVENT_CHANNELS` (`apps/desktop/src/preload/allowlist.ts`);
the router registers exactly those channels, validates every payload against a
per-channel schema (`ipc-schemas.ts`), refuses untrusted senders before validation,
rate-limits `credentials.*`, and maps errors to `IpcError` without stacks, paths or
secrets. There is no `execute`, `readFile` or `request(url)` channel. `credentials.get`
does not exist: the renderer can set, delete and ask _whether_ a key is present.

_Verification:_ `router: registers exactly the request catalogue and nothing else;
unknown channels are refused`; `router: every channel rejects a malformed payload…`;
`router: untrusted senders are refused before validation or handlers run`;
`router: credentials.* is rate limited to 10 per minute per window`;
`router: errors are mapped to IpcError without stacks, paths or secrets`;
`preload allowlist: only catalogue channels get a wire name`;
`credential store: round trip with encryption; file never contains plaintext; renderer-visible has() only`.

_Residual:_ a renderer compromise can still drive any legitimate capability (install a
pack the user has on disk, register a camera). The blast radius is the app's own
allowlisted surface.

### T6 Malicious `.worldpack`

_Threat:_ an imported pack escapes its directory (zip-slip), exhausts disk (zip bomb),
plants executables, or claims data it does not contain.

_Mitigation:_ `packages/offline/src/zip.ts` validates before extracting anything:
normalised names only (no absolute paths, `..`, backslashes or drive letters), no
symlink attributes, no executable extensions, no duplicates (case-insensitive), no
entries missing from the manifest and no manifest entries missing from the archive,
per-entry and total size caps, compression-ratio bomb check, CRC32 + SHA-256 verified
against the manifest, zip64/encryption/unknown methods refused. Extraction goes to a
staging directory and is renamed into place atomically; a failed import leaves nothing
behind. A pack contains data only — it can never contain code.

_Verification:_ the fourteen `zip:`/`adversarial:` tests in
`packages/offline/src/zip.test.ts`; `registry: a tampered pack is refused and leaves
nothing behind; reinstall replaces atomically`.

_Residual:_ packs are integrity-checked but **not signed** — a pack is only as
trustworthy as where the user got it. Signing is Release 2 (ADR-012).

### T7 Path traversal in user data and exports

_Threat:_ a provider id, pack id, camera id or collection name containing `../`
escapes the data directory.

_Mitigation:_ all user-data paths are composed through `packages/config/src/data-dirs.ts`,
which validates that the resolved path stays inside its root; ids are constrained by
the identifier grammar (`packages/world-model/src/identifiers.ts`); file dialogs are
main-process only (`HostBridge`), so the renderer never chooses a path.

_Verification:_ `data dirs: isInsideDir rejects traversal and absolute escapes`.

_Residual:_ a user who points an export at a directory they should not write to is
exercising their own permissions; WORLDVIEW constrains its own data directory, not the
account's reach.

### T8 Local sidecar exposure and localhost CSRF

_Threat:_ go2rtc's API or the camera relay is reachable from the network or from a web
page the user visits (a browser can POST to `http://127.0.0.1:…`).

_Mitigation:_ the sidecar config generated by `Go2rtcSidecar` binds the API to
`127.0.0.1:1984` and RTSP to `127.0.0.1:8554` only, and the sidecar is started only
when the user configures a binary path; the relay binds to loopback on a random port
and requires an unguessable per-camera token in the path, which a cross-site request
cannot know. The relay exposes no camera listing and no mutating endpoints, so a blind
cross-site POST achieves nothing.

_Verification:_ `relay binds to 127.0.0.1 on a random port and answers 404 for unknown
ids and wrong tokens`; the go2rtc config-generation tests assert loopback-only binds
and that an absent binary means the sidecar never starts.

_Residual:_ another local process running as the user can read the relay token from
the process list/memory; local-user isolation is the OS's job.

### T9 Update compromise

_Threat:_ a hostile update replaces the application.

_Mitigation:_ updates come from GitHub Releases with electron-updater metadata and are
hash-verified; **automatic installation stays disabled until Windows code signing is
configured** — unsigned builds only check and notify, and the user installs manually
(`packages/updater`, ADR-012). A prerelease never replaces a stable install unless the
user opted into the prerelease channel. No OS security control is weakened to make
silent updates work.

_Verification:_ the updater policy matrix tests (signed/unsigned × channel × automatic)
in `packages/updater`.

_Residual:_ until signing exists, the trust anchor is TLS to GitHub plus the hash in
the release metadata — sufficient against tampering in transit, not against a
compromised release account. Publishing requires a human (`docs/releases/RELEASE-PROCESS.md`).

### T10 Supply-chain / plugin compromise

_Threat:_ a malicious npm dependency, or a third-party "provider plugin", runs inside
the app.

_Mitigation:_ pinned package manager and lockfile; `pnpm audit` in CI at
high/critical; Dependabot proposes updates but nothing auto-merges; an SBOM is
generated for every release; **no runtime plugin loading exists** — the provider
registry is compiled in, and third-party provider installation is explicitly deferred
until signing, permissions and process isolation exist (directive §128).

_Verification:_ CI jobs `dependency-audit`, `sbom`, `license-audit`;
`registry: every key is a unique manifest id with a valid manifest and a fresh instance per call` and `registry: every shipped provider has a legal registry record whose dataPolicy matches its manifest`.

_Residual:_ a compromised dependency still runs with the app's privileges. Electron's
sandbox limits the renderer, not the main process.

### T11 Sensitive data in logs and diagnostics

_Threat:_ an API key, camera password or authorization header ends up in a log file or
in a diagnostics bundle the user posts to an issue.

_Mitigation:_ redaction happens once, centrally, in `packages/core/src/logger.ts`
(`redactText`/`redactFields`: key-like field names, query-string secrets, bearer
tokens, `user:pass@` URLs) and again when a diagnostics bundle is built
(`packages/diagnostics/src/redact.ts`), which also replaces the user's home directory
with `~`. Provider errors are sanitised at the source (`ProviderError.toInfo`).
The relay never logs injected credential headers.

_Verification:_ `logger redacts secrets in messages and fields`;
`http: credential injected by key, never exposed in errors…`;
`relay streams a fake MJPEG upstream with credential injection and never logs the header`;
the diagnostics redaction tests.

_Residual:_ a provider that embeds a secret in an unusual place (a response body echoed
into a message) could evade the patterns; the bundle is the user's to review before
sharing, and the issue template says so.

### T12 Malicious imported collection

_Threat:_ a shared collection file carries hostile strings (script, huge payloads) or
references that drive the app somewhere unexpected.

_Mitigation:_ imports are schema-validated before anything is stored; strings are
length-bounded; the renderer treats all of it as text. Import is initiated through a
main-process file dialog, never a renderer path.

_Verification:_ `integration: collections and lenses round-trip through the host bridge
and survive a restart`; the settings/user-document validation tests.

_Residual:_ a collection that validates can still describe somewhere misleading — it is
the sender's claim about the world, shown as text, and WORLDVIEW does not vouch for it.

### T13 Denial of service through resource exhaustion

_Threat:_ a feed with a million objects, or a worldpack that fills the disk, makes the
app unusable.

_Mitigation:_ batch caps, per-type expiry in the state engine, bounded track and
recent-observation buffers, bounded event store, retention sweeps capped by data policy,
per-entry/total size limits on pack import, LOD and feature caps in the presentation
pipeline (a 50k-object local view updates in ~9 ms in-thread; above 5,000 objects the
work moves to a worker, so a larger set slows the map rather than the interface).

_Verification:_ `spatial index: 100k objects bbox query stays fast`; the presentation
presentation benchmark (`pnpm benchmark`, recorded in the release verification report); `state: sweep
reclassifies freshness and expires by type policy…`.

_Residual:_ the caps keep the application responsive, not the machine: history and
installed packs grow on disk until retention or the operator removes them, and a
sustained feed far above the benchmarked scale degrades to fewer visible features
rather than failing outright.

### T14 Misuse against a private individual

_Threat:_ the product is turned into a tool for following a specific person.

_Mitigation:_ this is a product boundary, not only a technical control
(`docs/PRODUCT-BOUNDARIES.md`): no named-person search, no facial recognition, no
plate databases, no private-device tracking, no camera-frame analysis; identity
resolution joins only on authoritative _object_ identifiers (ADR-011), and the ALPR
layer inherited from upstream was removed. Feature requests are screened against this
boundary in the issue template. The shape of that boundary is checked mechanically by
`tools/dev/product-boundary.test.ts`, so a person-oriented capability cannot be added
without the build failing.

_Verification:_ `boundary: identity resolution merges only on authoritative object
identifiers (ADR-011)`; `boundary: no channel searches for a person, and no recognition
runs on a frame`; `boundary: no module that handles frame bytes writes them to disk`;
`boundary: the document and the threat model still state the commitment`.

_Residual:_ aircraft and vessel identifiers are public data that can be correlated with
ownership records outside WORLDVIEW. The boundary is about what this product builds,
not about what public data exists.

### T15 Tampered settings naming an arbitrary binary

_Threat:_ `settings.json` is a plain file the user (or anything running as the user) can
edit. `cameras.go2rtcPath` tells the runtime which program to launch, so a rewritten
settings file could point it at something else.

_Mitigation:_ the path crosses a trust boundary and is validated like any other input
(`appSettingsSchema`): it is either empty or absolute, never a bare name, so PATH and
the working directory are never consulted and a binary dropped beside the app cannot be
picked up by shadowing the expected name. The runtime spawns it directly with
`shell: false` and no inherited stdio, so the string is never interpreted by a shell,
and it is spawned only when an RTSP camera is actually added or opened — a machine with
no RTSP cameras never runs it regardless of the setting. Changing the path stops a
running process first, so a swap cannot leave the previous binary running under the new
label.

_Verification:_ `go2rtc: settings reject a relative binary path`, `go2rtc: a configured
path that does not exist reports not-configured and never spawns`, `go2rtc: unconfigured
is the default — nothing is spawned and the status says so`, and `sidecar: changing the
binary path stops the running process before the swap`.

_Residual:_ anything able to rewrite `settings.json` is already running as the user and
can execute code without WORLDVIEW's help, so this is hardening, not a privilege
boundary. WORLDVIEW checks that the configured binary exists and reports a version
mismatch against the pinned release, but does not verify its provenance — see
Assumptions.

### T16 The loopback listener (HTTP ingest)

_Threat:_ the one listener WORLDVIEW opens (`ProviderLocalAccess.listen`, for `local-process`
sources such as HTTP ingest) is reached from the network, from a web page the user visits
(a cross-site POST, or a page that rebinds a DNS name to `127.0.0.1`), or by a pusher that
floods it, and so writes observations — or reads the token — it should not.

_Mitigation:_ the runtime fixes the address at `127.0.0.1` (the provider names only a port
and a path) and refuses any peer that is not loopback. A request must name a loopback `Host`
with the listener's port, so a rebound page, which sends its own name, is refused (421). Only
`POST` to the one path is served; `OPTIONS` is refused, so no CORS preflight succeeds and a
browser never sends the `Authorization` header cross-site. Every request needs the bearer
token, which the runtime reads from the credential store per request and compares in time
independent of where the strings differ; the provider never sees it, and the header is
stripped (with cookies) before the provider is asked. Size is refused from `Content-Length`
and again while reading, rate over a sliding minute with `Retry-After`; timeouts are short.
Only `local-process` sources are offered a listener, one each, for a credential their
manifest declares, and the host closes it when the source stops or is disabled.

_Verification:_ `listener: loopback only, the path, POST, the bearer token, the Host header; the token and cookies never reach the provider`;
`listener: binds 127.0.0.1 only, refuses bad options, reports a port in use, and rate-limits with Retry-After`;
`the loopback listener is offered to local-process sources only, one at a time, for a declared credential, and closed when the source stops`.

_Residual:_ another local process running as the user can read the token from the
credential store or reach the port; local-user isolation is the OS's job. A LAN bind is out
of scope and would be its own reviewed amendment.

### T17 Files in a granted folder, and the user's ogr2ogr

_Threat:_ a file source's definition, or a link planted in the folder the user granted,
reads files outside it; or the `ogr2ogr` the host runs for `gdal-import` is made to read
outside the grant, receive the app's secrets, or run something else.

_Mitigation:_ a path is refused by one rule on both sides (`checkRelativePath`: no absolute,
drive, UNC, device or `..` path, no `:`, no Windows-reserved names), then the runtime
resolves the folder's and the file's real paths — links and junctions followed — and reads
only what is strictly inside, only regular files, checking that the handle it opened is the
file it checked. A source that declares its folder setting reads that folder and nothing
else (no fallback to the bundled resources). `ogr2ogr` is offered only to such sources: the
host looks it up on `PATH` (an `.exe` on Windows, never a `.bat` or `.cmd`, never the working
directory), runs it with a fixed argument list and `shell: false`, an environment reduced to
what GDAL needs (no `WORLDVIEW_`/`ONEVIEW_` variables), a timeout, an output cap and a fresh
temporary directory that is always removed, and converts only self-contained formats —
never VRT, GML or anything that can name other files — with every part of a dataset (a
shapefile's sidecars) checked inside the grant.

_Verification:_ `granted folder: a directory link out of the folder is refused; one that stays inside is read`;
`ogr2ogr host: fixed arguments, no shell, no WORLDVIEW secrets in its environment, the temporary folder removed`;
`ogr2ogr host: a failure, a hang, an empty run, an oversized result and refused inputs`;
`ogr2ogr host: a shapefile is its parts — an edited .dbf is a change, a .dbf linked out of the folder is refused`.

_Residual:_ unlike go2rtc (T15), `ogr2ogr` is found by name on `PATH`: whatever can change
the user's `PATH` can put another program there — but it is already running as the user.
GDAL is the user's own install; WORLDVIEW does not verify its provenance (see Assumptions).

### T18 Adding a source from the app (a URL the operator types, a file the app writes)

_Threat:_ the Add-source dialog is made to fetch from the machine's own network (SSRF) or to
leak something with the request; or a save writes outside the operator's folder, replaces a
file, or creates a definition that claims a review or opens a data policy nobody granted.

_Mitigation:_ the renderer only asks; the GET runs in main under the same URL policy a
definition's endpoint is held to (https, a public DNS name or IPv4 address — no loopback,
private or link-local address, no single-label name, no `localhost`, `.local`, `.internal`,
`.lan`, `.home.arpa` or similar private-use suffix, a trailing dot ignored — no credentials
in the URL), with an allowlist of
exactly that host, no cache, no retries, redirects not followed, an 8 MiB cap and a 20 s
timeout, and nothing sent but the GET; draft and save are limited to 10 a minute. The draft
is only returned, never written. A save takes an id of `a-z`, `0-9` and `-` and writes
`<id>.json` in the runtime's own folder (the path never comes from the renderer) with `wx`,
so an existing file is never replaced; `review: user-configured` and `enabled: false` are
forced, so the file validates under the user-configured rules (policy fails closed, ADR-013)
and runs only after the operator switches it on.

_Verification:_ `definitions: draft fetches one sample under the URL policy and returns the validator verdict`;
`definitions: save writes <id>.json disabled and user-configured, never over a file or a taken id`;
`definitions: without a folder there is nothing to list, draft or save`.

_Residual:_ a public DNS name can resolve to a private address: the check is on the name,
as it is for a definition's endpoint, so a name the operator types that points inside their
network is fetched once. The operator typed it; the response is only drafted, never run.

## Conventions

A name in backticks on a _Verification:_ line is the exact title of a test in this
repository, abbreviated with a trailing `…` when the full title is long.
`tools/dev/docs-claims.test.ts` checks every one of them against the suite, so a
renamed or deleted test fails the build rather than leaving a claim here that nothing
backs. Checklist checks and other non-test evidence are named in plain quotes.

## Assumptions

- The user's Windows account is not already compromised; `safeStorage` is only as
  strong as the OS account.
- The OS certificate store is intact.
- Sidecars and tools the user installs (go2rtc, readsb, GDAL's `ogr2ogr`) are the genuine
  builds — WORLDVIEW checks reachability or version, not provenance.

## Review triggers

Re-review this document when: a new IPC channel is added; a provider gains a new
transport; a setting gains the power to name an executable or a path the runtime acts
on; the camera relay or a sidecar changes; the worldpack format changes; the
updater gains automatic installation (after signing); or third-party provider loading
is introduced.
