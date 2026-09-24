# Waiting for amendment A1

These two `http-ingest` examples validate (`connector:test` passes their configuration), but the shared suite
(`packages/connector-runtime/src/testing/suite.ts`) drives only polling, socket and file sources: on a source that is
pushed to, its parse, empty, malformed, timeout, auth, rate, size, cancellation and mapping checks call `query`, which a
listener does not have. Amendment request A1 in `docs/roadmap/phases/ingest.md` asks for the suite's listener mode.
Until it lands they live one folder below `connectors/examples/ingest/`, where `connector:test --all` does not look, and
`packages/connector-runtime/src/connectors/ingest/ingest.test.ts` runs the same fixtures through the listener. When A1
lands, move them up a folder and delete this file.
