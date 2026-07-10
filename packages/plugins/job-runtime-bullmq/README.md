# @ever-works/job-runtime-bullmq-plugin

BullMQ `IJobRuntimeProvider` plugin for the Ever Works platform.

## Plugin metadata

| Field        | Value                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| ID           | `job-runtime-bullmq`                                                                                                 |
| Category     | `job-runtime`                                                                                                        |
| Capabilities | `job-runtime-enqueue`, `job-runtime-cancel`, `job-runtime-status`, `job-runtime-schedule`, `job-runtime-bind-tenant` |
| Runtime id   | `bullmq` (selected via `EVER_WORKS_JOB_RUNTIME=bullmq`)                                                              |
| License      | AGPL-3.0                                                                                                             |
| Built-in     | yes                                                                                                                  |
| Auto-enable  | no                                                                                                                   |

## What this plugin ships

- **Full `IJobRuntimeProvider` contract surface** — drops into the binding factory in `packages/agent/src/tasks/job-runtime.providers.ts` alongside Trigger.dev.
- **Real `bindToTenant`** with per-`(tenantId, credentialVersion)` memoisation. Exposes the per-tenant Redis `queuePrefix` + optional `redisUrl` on the bound view (`BullMqTenantBindingView`) so dispatchers can route to per-tenant Redis namespaces (ADR-017 — Redis prefix isolation per tenant worker).
- **Operator-pluggable real dispatchers + worker host** via `BullMqDispatcherFactory` + `BullMqWorkerHostFactory`. The plugin package itself does NOT depend on `bullmq`/`ioredis` — operators pin and inject `{ Queue, Worker }` from their own install.
- **Throwing-stub defaults** until the operator wires real dispatchers, so an incorrectly-configured deployment fails loudly at first dispatch rather than silently dropping work.

## Operator setup

1. Install peer deps in your worker app:
    ```bash
    pnpm add bullmq ioredis
    ```
2. Configure the plugin's env vars:
    - `BULLMQ_REDIS_URL` — connection string (e.g. `redis://default:pw@redis:6379`)
    - `BULLMQ_QUEUE_PREFIX` — instance-default Redis key prefix
3. Set `EVER_WORKS_JOB_RUNTIME=bullmq` on the API.
4. In your worker app, build the dispatcher + worker host factories and inject them into the plugin:

    ```ts
    import { Queue, Worker } from 'bullmq';
    import IORedis from 'ioredis';
    import {
    	BullMqJobRuntimePlugin,
    	BullMqDispatcherFactory,
    	BullMqWorkerHostFactory
    } from '@ever-works/job-runtime-bullmq-plugin';

    const connection = new IORedis(process.env.BULLMQ_REDIS_URL!, { maxRetriesPerRequest: null });
    const dispatchers = new BullMqDispatcherFactory({ Queue, Worker }, { connection, prefix: 'ew' });
    const workerHost = new BullMqWorkerHostFactory({ Queue, Worker }, { connection, prefix: 'ew' });

    workerHost.register('kb-embed-document', async (job) => {
    	// operator-defined handler
    });

    const plugin = new BullMqJobRuntimePlugin()
    	.useDispatchers({
    		dispatchKbEmbedDocument: (payload) =>
    			dispatchers.forQueue('kb-embed-document').dispatch('kb-embed-document', payload)
    		// ... other dispatchXxx methods
    	})
    	.useDispatcherFactory(dispatchers)
    	.useWorkerHostFactory(workerHost);
    ```

## Tenant overlay (EW-742)

This plugin participates in the tenant-scoped job-runtime overlay defined in [`docs/specs/features/tenant-job-runtime-overlay/`](../../../docs/specs/features/tenant-job-runtime-overlay/spec.md). Each tenant can opt into one of three modes via `tenant_job_runtime_config`:

| Mode       | Behaviour                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `inherit`  | (default) Use the instance-default Redis + queue prefix. Byte-identical to the pre-overlay path.                                |
| `byo`      | Tenant supplies their own Redis URL and/or queue prefix; runs execute against their isolated namespace.                         |
| `override` | Same data plane as BYO; differs only by intent (tenant runs same provider kind as instance default with their own credentials). |

### Tenant credential bag shape

`credentials` on the `TenantCredentialSnapshot` accepts:

```jsonc
{
	"queuePrefix": "tenant-acme", // Redis key prefix (per ADR-017 prefix isolation)
	"redisUrl": "rediss://..." // optional — dedicated per-tenant Redis
}
```

Both fields surface on the `BullMqTenantBindingView` as `tenantQueuePrefix` and `tenantRedisUrl`.

### Per-tenant dispatcher routing

For per-tenant prefix isolation, pass a `dispatchersBuilder` callback that returns a `JobRuntimeDispatchers` map built against a per-tenant `BullMqDispatcherFactory`:

```ts
const tenantFactories = new Map<string, BullMqDispatcherFactory>();

const plugin = new BullMqJobRuntimePlugin({
	dispatchersBuilder: (snap) => {
		const prefix = (snap.credentials.queuePrefix as string) ?? `bull:tenant:${snap.tenantId}:`;
		let f = tenantFactories.get(prefix);
		if (!f) {
			f = new BullMqDispatcherFactory({ Queue, Worker }, { connection, prefix });
			tenantFactories.set(prefix, f);
		}
		return {
			dispatchKbEmbedDocument: (payload) =>
				f!.forQueue('kb-embed-document').dispatch('kb-embed-document', payload)
			// ...
		};
	}
});
```

The platform calls `plugin.bindToTenant(snapshot)` at resolve time and the returned view's `dispatchers` reflect the per-tenant factory.

### Cross-references

- Tenant overlay spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
- Per-provider matrix + isolation models: [`docs/specs/features/tenant-job-runtime-overlay/providers.md` § BullMQ](../../../docs/specs/features/tenant-job-runtime-overlay/providers.md#bullmq)
- ADR-017 (Q-bullmq Redis prefix isolation): [`docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md`](../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
- Conformance suite (EW-685 P6): [`@ever-works/plugin/contracts-conformance`](../../plugin/src/contracts-conformance/index.ts) — `runJobRuntimeContractSuite` is wired into `src/__tests__/bullmq-conformance.spec.ts`.

## Local development

```bash
pnpm install
pnpm --filter @ever-works/job-runtime-bullmq-plugin build
pnpm --filter @ever-works/job-runtime-bullmq-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [BullMQ documentation](https://docs.bullmq.io)

## License

AGPL-3.0
