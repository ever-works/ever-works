# @ever-works/job-runtime-trigger-plugin

Trigger.dev `IJobRuntimeProvider` plugin for the Ever Works platform — canonical pluggable form of the `trigger` runtime, peer of the BullMQ / pg-boss / Temporal / Inngest plugins.

> **Note:** The synthetic `TriggerJobRuntimeProvider` shim at `packages/tasks/src/trigger/` stays as the operator's NestJS-bound reference implementation (wired directly into `TriggerModule` for the in-monorepo API). This package is the canonical pluggable form that the standard plugin pipeline discovers via the `everworks.plugin` manifest block.

## Plugin metadata

| Field        | Value                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| ID           | `job-runtime-trigger`                                                                                                |
| Category     | `job-runtime`                                                                                                        |
| Capabilities | `job-runtime-enqueue`, `job-runtime-cancel`, `job-runtime-status`, `job-runtime-schedule`, `job-runtime-bind-tenant` |
| Runtime id   | `trigger` (selected via `EVER_WORKS_JOB_RUNTIME=trigger`)                                                            |
| License      | AGPL-3.0                                                                                                             |
| Built-in     | yes                                                                                                                  |
| Auto-enable  | no                                                                                                                   |

## What this plugin ships

- **Full `IJobRuntimeProvider` contract surface**.
- **Real `bindToTenant`** with per-`(tenantId, credentialVersion)` memoisation. Exposes the per-tenant `projectAccessToken` on the bound view (`TriggerTenantBindingView`).
- **Operator-pluggable real dispatchers** via `TriggerDispatcherFactory` (`dispatch`, `enqueue`, `cancel`). The plugin package itself does NOT depend on `@trigger.dev/sdk` — operators install and pin it.
- **`mapTriggerEnqueueOptions`** — translator from platform `JobEnqueueOptions` onto Trigger.dev's native option carriers (`idempotencyKey`, `concurrencyKey`, `tags`, `maxDuration`, `machine`, `metadata.tenantId`).
- **`mapTriggerStatus`** — projection from the Trigger.dev SDK v4 status enum onto the contract's 6-value `JobRunStatus` union, matching the in-repo reference implementation exactly.

Trigger.dev is the **push-model** member of the family — Trigger.dev's cloud invokes the operator's deployed task package on its own machines. `startWorkerHost` intentionally stays a no-op even when operator hooks are wired (there is no worker process to start; mirrors Inngest).

## Operator setup

1. Install peer dep:
    ```bash
    pnpm add @trigger.dev/sdk
    ```
2. Configure env vars:
    - `TRIGGER_SECRET_KEY` — server-side prod secret (`tr_prod_*`) used by `tasks.trigger`
    - `TRIGGER_PROJECT_REF` — Trigger.dev project reference (e.g. `proj_abc123`)
    - `TRIGGER_API_URL` (optional) — override for self-hosted Trigger.dev
3. Set `EVER_WORKS_JOB_RUNTIME=trigger` on the API (this is the default).
4. Build a `TriggerDispatcherFactory` from the SDK's module-level `tasks` / `runs` namespaces and wire dispatchers:

    ```ts
    import { runs, tasks } from '@trigger.dev/sdk';
    import { TriggerJobRuntimePlugin, TriggerDispatcherFactory } from '@ever-works/job-runtime-trigger-plugin';

    // Trigger.dev v4 — the SDK reads TRIGGER_SECRET_KEY from env, and the
    // `tasks` / `runs` namespaces are imported as module-level objects.
    // The plugin only needs a structural { tasks, runs } client.
    const client = { tasks, runs };
    const factory = new TriggerDispatcherFactory({
    	client,
    	defaultTaskQueue: 'platform-default'
    });

    const plugin = new TriggerJobRuntimePlugin({ client })
    	.useDispatchers({
    		dispatchKbEmbedDocument: (payload) => factory.enqueue('kb-embed-document', payload, { tags: ['kb'] })
    	})
    	.useDispatcherFactory(factory);
    ```

    The plugin's own `cancel` / `getRunStatus` calls into `client.runs.cancel` / `client.runs.retrieve` when the optional `client` opt is set; without it they return safe defaults (`false` / `'unknown'`) and operators call `factory.cancel(runId)` directly.

## Tenant overlay (EW-742)

> **Per-tenant projects required for BYO/override.** Per [`providers.md` § Trigger.dev](../../../docs/specs/features/tenant-job-runtime-overlay/providers.md#triggerdev), the Trigger.dev SDK is project-scoped — there's no in-process per-call project switching. BYO and override modes both require the operator to maintain one Trigger.dev project per tenant (auto-provisioned in `inherit / per-tenant`, tenant-supplied in `byo`).

| Mode       | Behaviour                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inherit`  | (default) Use the operator's instance-default Trigger.dev project. In `shared` sub-mode, tenant id stamps onto `metadata.tenantId` / run tag for demultiplexing. |
| `byo`      | Tenant supplies their own `projectRef` + `projectAccessToken`. Per-tenant webhook URL: `POST /api/jobs/webhook/<tenant-id>/trigger-dev`.                         |
| `override` | Same data plane as BYO — UI distinction only (one-click "use my own Trigger.dev project").                                                                       |

### Tenant credential bag shape

```jsonc
{
	"projectRef": "proj_...", // tenant project reference
	"projectAccessToken": "tr_prod_..." // tenant prod secret (server-side)
}
```

Surface on the view as `tenantProjectAccessToken`.

### Per-tenant routing constraints

Trigger.dev's SDK pins to a single project at module load — there is no in-process project switching. For BYO/override:

1. Build one `{ tasks, runs }` client per tenant project (each constructed against the tenant's `projectAccessToken`).
2. Thread per-tenant `TriggerDispatcherFactory` instances via `dispatchersBuilder` so `bindToTenant(snapshot)` views route to the right Trigger.dev project.
3. Per-tenant webhook URLs (`/api/jobs/webhook/<tenant-id>/trigger-dev`) handle inbound invocations — the operator's tenant resolver loads the overlay from the path segment and validates the signature against the tenant's `projectAccessToken`.

### Per-provider gotchas

- The operator PAT (`tr_pat_*`) can **create** projects via `POST /api/v1/orgs/{orgId}/projects` but **cannot** read the resulting `tr_prod_*` secret — it must be copied from the dashboard. This breaks the zero-touch promise of `inherit / per-tenant`; see `providers.md` § Trigger.dev for the worker-self-registration workaround.
- Per-project rate limits apply at the Trigger.dev account level; large `inherit / per-tenant` deployments must monitor org-wide project counts.

### Cross-references

- Tenant overlay spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
- Per-provider matrix: [`docs/specs/features/tenant-job-runtime-overlay/providers.md` § Trigger.dev](../../../docs/specs/features/tenant-job-runtime-overlay/providers.md#triggerdev)
- ADR-017 (per-tenant project constraint): [`docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md`](../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
- Conformance suites: `src/__tests__/trigger-conformance.spec.ts` runs `runJobRuntimeContractSuite`; `src/__tests__/trigger-tenant-conformance.spec.ts` runs `runJobRuntimeTenantContractSuite`.

## Local development

```bash
pnpm install
pnpm --filter @ever-works/job-runtime-trigger-plugin build
pnpm --filter @ever-works/job-runtime-trigger-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Trigger.dev documentation](https://trigger.dev/docs)
- [Plugin system](../../plugin/README.md)

## License

AGPL-3.0
