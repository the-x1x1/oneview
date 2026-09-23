# ADR-007 — Offline world packs (.worldpack)

Status: Accepted · 2026-09-21 · Package: `@worldview/offline`, `tools/worldpack`

## Decision

- A `.worldpack` is a ZIP-container of **data only**: `manifest.json`, `maps/*.pmtiles`, `data/*.parquet|*.geojson`, `search/index.json`, `licenses/NOTICES.md`. Never code. The manifest (`WorldPackManifest`) declares bounds, contents, per-source policies (`offlinePackAllowed` must be true for every included source), minimum app version and SHA-256 checksums for every file.
- Import validates: archive structure, no path traversal, no absolute paths, no symlinks, no executable extensions, per-file and total decompression limits, manifest schema, checksums — fail closed.
- Builder CLI: `pnpm worldpack build --region hawaii --include map,places,airports,earthquakes` (presets, bbox, radius, source selection). Sources whose policy forbids redistribution are refused.
- Offline terrain is not implied by PMTiles: 3D offline = ellipsoid (or a local quantized-mesh terrain adapter when legally available); 2D offline = full PMTiles/MapLibre map.
- Local place search uses a pure-TS inverted index (`search/index.json`) in Release 1; SQLite FTS5 is the planned upgrade behind the same `PlaceIndex` interface.
- 2026-09-23 amendment (signing): a pack may carry `manifest.sig` beside `manifest.json` — an Ed25519 signature over the manifest's exact bytes, with the signer's raw public key and a 16-hex-digit key id derived from it (`worldview-pack-signature@1`). The manifest already lists a SHA-256 for every file, so this signs the whole pack; the signature file is never listed in the manifest. A signature that is malformed or does not verify is refused on import whatever the trust settings, and re-checked on every scan of installed packs (a manifest edited after installation reads as tampered). Trust is the operator's: publishers are added from the `.worldpack-pub` file a publisher hands out, or from a verified pack's signer, and kept in `worldpacks/trust.json`, compared by full public key. `requireTrusted` (off by default — no publisher exists until someone makes a key) refuses unsigned and unknown-key packs on install and sets installed ones aside. There is no built-in publisher key. Keys are made with `pnpm worldpack keygen`, which writes the private key owner-only and refuses a git work tree (directive §74); `pnpm worldpack build --sign` and `pnpm worldpack sign` sign. A runtime that cannot run Ed25519 reports `unchecked`, which is never trusted.

## Consequences

Offline claims are proven by `pnpm test:offline` with `WORLDVIEW_NETWORK=off` (remote providers must report OFFLINE, packs load, local search answers "Honolulu").
