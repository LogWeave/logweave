# LogWeave API Server

Node.js/Express/TypeScript server handling log ingestion, dashboard queries, alerting, and authentication.

## Quick Start

```bash
pnpm install
pnpm dev          # dev server with hot reload
pnpm test         # run tests (verbose)
pnpm test:dot     # run tests (compact output)
pnpm typecheck    # type check
pnpm lint         # Biome lint
```

Integration tests require ClickHouse (for db/) and Floci (for the S3
adapter integration). Boot what you need:

```bash
docker compose up clickhouse -d                       # for tests/db/
docker run -d --rm --name floci -p 4566:4566 \
  floci/floci:latest                                   # for tests/integration/s3-adapter*
pnpm test:integration
```

Tests skip themselves automatically when the required service isn't
reachable, so partial setups are fine.

### S3 adapter integration

`tests/integration/s3-adapter.integration.test.ts` exercises the
end-to-end `S3Adapter → STSClient/S3Client → ListObjectsV2/GetObject`
path against [Floci](https://floci.io/), a fast MIT-licensed AWS
emulator. CI provides Floci as a service container; locally it's
optional.

Override the endpoint via `FLOCI_ENDPOINT` if Floci is on a non-default
host or port.

Known limitation: free AWS emulators (Floci, LocalStack Community) do
not evaluate IAM trust-policy conditions like `sts:ExternalId`. The
integration test verifies SDK call shape and adapter wiring;
trust-condition enforcement is exercised by the unit tests in
`tests/connectors/s3-sts-errors.test.ts` against the AWS SDK error
catalog (real AWS evaluates the policy in production).

## Configuration

See [install guide](../../docs/install.md#environment-variable-reference) for all `LOGWEAVE_*` env vars.
