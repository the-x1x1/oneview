# File examples awaiting amendments

These six definitions are complete and pass the shared connector suite — but only through
the phase's shim (`packages/connector-runtime/src/connectors/files/testing/suite-shim.ts`,
run by `files.test.ts`), because two frozen contracts cannot carry them yet:

- **A1** — the definition schema drops keys it does not know, so the `file` block never
  reaches the connector and `pnpm connector:test` refuses every file definition.
- **A4** — the shared suite feeds a fixture only as an HTTP response or a socket message; it
  has no way to serve one as a file in a granted folder.

`pnpm connector:test --all` reads `connectors/examples` and its immediate subdirectories, so
it does not reach this folder; that is deliberate and temporary. When the integrator lands A1
and A4 (docs/roadmap/phases/files.md, "Amendment requests"), move these files up one level
into `connectors/examples/files/`, delete this README and the shim, and the command runs them
like every other example.
