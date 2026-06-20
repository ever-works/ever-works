# @ever-works/job-runtime-pgboss-plugin

pg-boss `IJobRuntimeProvider` plugin for the Ever Works platform.

## Plugin metadata

| Field        | Value                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| ID           | `job-runtime-pgboss`                                                                                                        |
| Category     | `job-runtime`                                                                                                               |
| Capabilities | `job-runtime-enqueue`, `job-runtime-cancel`, `job-runtime-status`, `job-runtime-schedule`, `job-runtime-bind-tenant`        |
| Runtime id   | `pgboss` (selected via `EVER_WORKS_JOB_RUNTIME=pgboss`)                                                                     |
| License      | AGPL-3.0                                                                                                                    |
| Built-in     | yes                                                                                                                         |
| Auto-enable  | no                                                                                                                          |

## What this plugin ships

- **Full `IJobRuntimeProvider` contract surface**.
- **Real `bindToTenant`** with per-`(tenantId, credentialVersion)` memoisation. Exposes the per-tenant Postgres `schema` + optional `connectionString` on the bound view (`PgBossTenantBindingView`) so dispatchers can route to per-tenant schemas (ADR-017 Q2 — schema-per-tenant).
- **Operator-pluggable real dispatchers + worker host** via `PgBossDispatcherFactory` + `PgBossWorkerHostFactory`. The plugin package itself does NOT depend on `pg-boss` — operators pin and inject a fully-constructed `PgBoss` instance.
- **`getRunStatus` projection** — pg-boss state (`created`/`retry`/`active`/`completed`/`expired`/`cancelled`/`failed`) → canonical `JobRunStatus` (`queued`/`running`/`completed`/`failed`/`cancelled`/`unknown`).
- **`registerSchedules`** delegates to `boss.schedule(name, cron, payload)`.

## Operator setup

1. Install peer dep in your worker app:
   ```bash
   pnpm add pg-boss
   ```
2. Configure env vars:
   - `PGBOSS_CONNECTION_STRING` — Postgres connection string
   - `PGBOSS_SCHEMA` — instance-default Postgres schema
3. Set `EVER_WORKS_JOB_RUNTIME=pgboss` on the API.
4. Wire the operator factories into the plugin:

   ```ts
   import PgBoss from 'pg-boss';
   import {
       PgBossJobRuntimePlugin,
       PgBossDispatcherFactory,
       PgBossWorkerHostFactory
   } from '@ever-works/job-runtime-pgboss-plugin';

   const boss = new PgBoss({
       connectionString: process.env.PGBOSS_CONNECTION_STRING!,
       schema: process.env.PGBOSS_SCHEMA ?? 'ew'
   });
   await boss.start();

   const dispatchers = new PgBossDispatcherFactory({ boss });
   const workerHost = new PgBossWorkerHostFactory({ boss });

   workerHost.register('kb-embed-document', { teamSize: 4 }, async (job) => {
       // operator-defined handler
   });

   const plugin = new PgBossJobRuntimePlugin()
       .useDispatchers({
           dispatchKbEmbedDocument: (payload) => dispatchers.send('kb-embed-document', payload)
       })
       .useDispatcherFactory(dispatchers)
       .useWorkerHostFactory(workerHost);
   ```

## Tenant overlay (EW-742)

This plugin participates in the tenant-scoped job-runtime overlay defined in [`docs/specs/features/tenant-job-runtime-overlay/`](../../../docs/specs/features/tenant-job-runtime-overlay/spec.md).

| Mode       | Behaviour                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `inherit`  | (default) Use the instance-default Postgres schema. Byte-identical to the pre-overlay path.                                  |
| `byo`      | Tenant supplies their own Postgres connection string and/or schema; runs execute against their isolated schema.              |
| `override` | Same data plane as BYO; differs only by intent.                                                                              |

### Tenant credential bag shape

```jsonc
{
    "schema": "tenant_acme",                 // per-tenant Postgres schema (ADR-017 Q2)
    "connectionString": "postgres://..."     // optional — dedicated per-tenant DB
}
```

Surface on the view as `tenantSchema` and `tenantConnectionString`.

### Per-tenant dispatcher routing

For per-tenant schema isolation, build one `PgBoss` instance per tenant schema, wrap each in its own factory, and thread per-tenant factories through `dispatchersBuilder`. Each `boss.start()` must be coordinated by the operator (e.g. start lazily on first bind).

### Cross-references

- Tenant overlay spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
- Per-provider matrix: [`docs/specs/features/tenant-job-runtime-overlay/providers.md` § pg-boss](../../../docs/specs/features/tenant-job-runtime-overlay/providers.md#pg-boss)
- ADR-017 (Q2 schema-per-tenant): [`docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md`](../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
- Conformance suite: `src/__tests__/pgboss-conformance.spec.ts` runs `runJobRuntimeContractSuite` from `@ever-works/plugin/contracts-conformance`.

## Local development

```bash
pnpm install
pnpm --filter @ever-works/job-runtime-pgboss-plugin build
pnpm --filter @ever-works/job-runtime-pgboss-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [pg-boss documentation](https://github.com/timgit/pg-boss)
- [Plugin system](../../plugin/README.md)

## License

AGPL-3.0
