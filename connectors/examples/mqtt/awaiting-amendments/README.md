# MQTT examples awaiting amendments

These five definitions are complete and pass the connector suite's checks, but only through
the suite's MQTT mode in `packages/connector-runtime/src/connectors/mqtt/testing/suite.ts`,
run by `mqtt.test.ts`. Two frozen contracts cannot carry them yet:

- **M1**: the definition schema drops keys it does not know, so the `mqtt` block never
  reaches the connector and `pnpm connector:test` refuses every MQTT definition ("mqtt is
  required").
- **M2**: the shared suite drives a definition only by HTTP responses, socket messages or a
  granted file. It never gives the provider a `testing.FixtureMqtt`.

`pnpm connector:test --all` reads `connectors/examples` and its immediate subdirectories, so
it does not reach this folder. That is deliberate and temporary. When the integrator lands M1
and M2 (docs/roadmap/phases/mqtt.md, "Amendment requests"), move these files up one level
into `connectors/examples/mqtt/`, delete this README, and the command runs them like every
other example.
