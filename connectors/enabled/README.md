# Shipped connector definitions

Definitions in this directory ship with the application: `pnpm stage:resources` copies
every `*.json` here (not `*.test.json` sidecars) to `apps/desktop/resources/data/connectors/enabled/`,
which electron-builder packages and the runtime reads at startup with each file's own
`review` level. To be here a definition must be reviewed — `review: "bundled"` or
`"commercially-reviewed"` — and have a record in `config/licenses/providers.json` whose
`commercialReview` and data policy equal what the definition resolves to; `pnpm license-audit`
fails otherwise, and a `user-configured` file here fails it too. Tested like any other
definition: a sidecar beside it and `pnpm connector:test --all --dir connectors/enabled`.

Nothing is shipped from here yet. `pending-review/` holds definitions written to replace a
bespoke provider (phase `provider-migration`, docs/providers/MIGRATION-MATRIX.md) that wait
for that review: they are `user-configured` and disabled, and neither `pnpm license-audit`
nor `pnpm stage:resources` reads a subdirectory, so nothing in it ships. The command above
tests it all the same. Reviewing one means moving it and its sidecar up here, setting its
`review`, and adding its record — the matrix lists the record for each.
Examples that are tested but not shipped are in `../examples/`.
