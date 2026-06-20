# @ever-works/job-runtime-temporal-plugin

Temporal `IJobRuntimeProvider` plugin for the Ever Works platform.

## Plugin metadata

| Field        | Value                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| ID           | `job-runtime-temporal`                                                                                                      |
| Category     | `job-runtime`                                                                                                               |
| Capabilities | `job-runtime-enqueue`, `job-runtime-cancel`, `job-runtime-status`, `job-runtime-schedule`, `job-runtime-bind-tenant`        |
| Runtime id   | `temporal` (selected via `EVER_WORKS_JOB_RUNTIME=temporal`)                                                                 |
| License      | AGPL-3.0                                                                                                                    |
| Built-in     | yes                                                                                                                         |
| Auto-enable  | no                                                                                                                          |

## What this plugin ships

- **Full `IJobRuntimeProvider` contract surface**.
- **Real `bindToTenant`** with per-`(tenantId, credentialVersion)` memoisation. Exposes the per-tenant Temporal `namespace` on the bound view (`TemporalTenantBindingView`) per ADR-017 Q1 (namespace-per-tenant).
- **Operator-pluggable real dispatchers + worker scaffolding** via `TemporalDispatcherFactory` + `TemporalWorkerHostFactory`. The plugin package itself does NOT depend on `@temporalio/client` or `@temporalio/worker` (the worker SDK ships `@temporalio/core-bridge` native code that should not be pulled into every install).
- **`getRunStatus` projection** — Temporal `WorkflowExecutionStatus` (`RUNNING`/`COMPLETED`/`FAILED`/`CANCELED`/`TERMINATED`/`TIMED_OUT`/`CONTINUED_AS_NEW`) → canonical `JobRunStatus`.

## Operator setup

1. Install peer deps in your worker app:
   ```bash
   pnpm add @temporalio/client @temporalio/worker
   ```
2. Configure env vars:
   - `TEMPORAL_ADDRESS` — gRPC endpoint (e.g. `temporal.tenant-acme.svc:7233`)
   - `TEMPORAL_NAMESPACE` — instance-default namespace
   - `TEMPORAL_TLS_CERT` + `TEMPORAL_TLS_KEY` — mTLS pair (recommended)
3. Set `EVER_WORKS_JOB_RUNTIME=temporal` on the API.
4. Wire the operator factories. Worker construction goes through a `build()` callback so `@temporalio/worker`'s heavy deps stay operator-owned:

   ```ts
   import { Connection, WorkflowClient } from '@temporalio/client';
   import { Worker, NativeConnection } from '@temporalio/worker';
   import * as activities from './activities';
   import {
       TemporalJobRuntimePlugin,
       TemporalDispatcherFactory,
       TemporalWorkerHostFactory
   } from '@ever-works/job-runtime-temporal-plugin';

   const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS! });
   const client = new WorkflowClient({ connection, namespace: process.env.TEMPORAL_NAMESPACE! });

   const dispatchers = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
   const workerHost = new TemporalWorkerHostFactory();

   workerHost.register({
       taskQueue: 'ew',
       build: () => Worker.create({
           connection: await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS! }),
           namespace: process.env.TEMPORAL_NAMESPACE!,
           taskQueue: 'ew',
           workflowsPath: require.resolve('./workflows'),
           activities
       })
   });

   const plugin = new TemporalJobRuntimePlugin()
       .useDispatchers({
           dispatchKbEmbedDocument: async (payload) => {
               const handle = await dispatchers.start('kbEmbedDocumentWorkflow', {
                   workflowId: `kb-embed:${payload.workId}`,
                   args: [payload]
               });
               return handle.workflowId;
           }
       })
       .useDispatcherFactory(dispatchers)
       .useWorkerHostFactory(workerHost);
   ```

## Tenant overlay (EW-742)

| Mode       | Behaviour                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `inherit`  | (default) Use the instance-default Temporal namespace.                                                                 |
| `byo`      | Tenant supplies their own namespace, address, and mTLS pair; runs execute against their isolated namespace.            |
| `override` | Same data plane as BYO; differs only by intent.                                                                        |

### Tenant credential bag shape

```jsonc
{
    "namespace": "tenant-acme",   // per-tenant Temporal namespace (ADR-017 Q1)
    "address": "temporal.tenant-acme.svc:7233",  // optional — dedicated cluster
    "tlsCert": "-----BEGIN CERTIFICATE-----...",
    "tlsKey": "-----BEGIN PRIVATE KEY-----..."
}
```

Surface on the view as `tenantNamespace`.

### Per-tenant routing

For namespace-per-tenant, build one `WorkflowClient` per tenant namespace and one factory per client; pass per-tenant factories via `dispatchersBuilder`. Worker host registration can be reused across tenants when each tenant's workflows share the same task queue.

### Cross-references

- Tenant overlay spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
- Per-provider matrix: [`docs/specs/features/tenant-job-runtime-overlay/providers.md` § Temporal](../../../docs/specs/features/tenant-job-runtime-overlay/providers.md#temporal)
- ADR-017 (Q1 namespace-per-tenant): [`docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md`](../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
- Conformance suite: `src/__tests__/temporal-conformance.spec.ts` runs `runJobRuntimeContractSuite`.

## Local development

```bash
pnpm install
pnpm --filter @ever-works/job-runtime-temporal-plugin build
pnpm --filter @ever-works/job-runtime-temporal-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Temporal documentation](https://docs.temporal.io)
- [Plugin system](../../plugin/README.md)

## License

AGPL-3.0
