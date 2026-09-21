# World pack development

Everything about building, verifying and importing `.worldpack` files lives in
[docs/OFFLINE-PACKS.md](../OFFLINE-PACKS.md): the container format and allowed files,
the manifest schema, the fail-closed source-policy checks, integrity verification on
import, the `pnpm worldpack` CLI (including how to cut a Protomaps basemap extract
legally) and how the app consumes installed packs.

For provider authors the short version is:

- Your provider's `dataPolicy` in `config/licenses/providers.json` decides whether its
  data can ever be packed: both `offlinePackAllowed` and `redistributionAllowed` must be
  `true`, and `attributionText` must be set when attribution is required. The builder
  refuses anything else and the manifest schema rejects packs that claim otherwise.
- History rows your provider writes (`normalizedRetentionAllowed`) are what the
  `earthquakes`-style history layers are cut from; keep `objectType` stable.
- Layers you want in packs should be plain GeoJSON `Point` features with flat properties
  (see `fixtures/airports/README.md` for the airport layer schema the infrastructure
  provider consumes).
