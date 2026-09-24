# Shipped connector definitions

Definitions in this directory ship with the application: `pnpm stage:resources` copies
every `*.json` here (not `*.test.json` sidecars) to `apps/desktop/resources/data/connectors/enabled/`,
which electron-builder packages and the runtime reads at startup with each file's own
`review` level. To be here a definition must be reviewed — `review: "bundled"` or
`"commercially-reviewed"` — and have a record in `config/licenses/providers.json` whose
`commercialReview` and data policy equal what the definition resolves to; `pnpm license-audit`
fails otherwise, and a `user-configured` file here fails it too. Tested like any other
definition: a sidecar beside it and `pnpm connector:test --all --dir connectors/enabled`.

Nothing here yet: the first shipped definitions come from phase `provider-migration`
(docs/roadmap/phases/provider-migration.md). Examples that are tested but not shipped are
in `../examples/`.
