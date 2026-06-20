# @ever-works/job-runtime-inngest-plugin

Inngest `IJobRuntimeProvider` plugin for the Ever Works platform.

## Plugin metadata

| Field        | Value                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| ID           | `job-runtime-inngest`                                                                                                       |
| Category     | `job-runtime`                                                                                                               |
| Capabilities | `job-runtime-enqueue`, `job-runtime-cancel`, `job-runtime-status`, `job-runtime-schedule`, `job-runtime-bind-tenant`        |
| Runtime id   | `inngest` (selected via `EVER_WORKS_JOB_RUNTIME=inngest`)                                                                   |
| License      | AGPL-3.0                                                                                                                    |
| Built-in     | yes                                                                                                                         |
| Auto-enable  | no                                                                                                                          |

## What this plugin ships

- **Full `IJobRuntimeProvider` contract surface**.
- **Real `bindToTenant`** with per-`(tenantId, credentialVersion)` memoisation. Exposes the per-tenant `eventKey` + `signingKey` on the bound view (`InngestTenantBindingView`).
- **Operator-pluggable real dispatchers + Inngest function defs** via `InngestDispatcherFactory`. The plugin package itself does NOT depend on `inngest` — operators install and pin it.
- **`plugin.functions`** — surfaces every function registered through the bound factory so the operator can pass them straight to `serve({ client, functions })` at their HTTP mount point.

Inngest is the **serverless** member of the family — the operator's HTTP `serve()` route IS the worker host. `startWorkerHost` intentionally stays a no-op even when operator hooks are wired (there is no worker process to start).

## Operator setup

1. Install peer dep:
   ```bash
   pnpm add inngest
   ```
2. Configure env vars:
   - `INNGEST_EVENT_KEY` — used by `inngest.send()`
   - `INNGEST_SIGNING_KEY` — used to verify inbound webhook requests
3. Set `EVER_WORKS_JOB_RUNTIME=inngest` on the API.
4. Build the dispatcher factory + Inngest client, register functions, and mount `serve()`:

   ```ts
   import { Inngest } from 'inngest';
   import { serve } from 'inngest/next';
   import {
       InngestJobRuntimePlugin,
       InngestDispatcherFactory
   } from '@ever-works/job-runtime-inngest-plugin';

   const client = new Inngest({
       id: 'ever-works',
       eventKey: process.env.INNGEST_EVENT_KEY,
       signingKey: process.env.INNGEST_SIGNING_KEY
   });
   const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ever.works' });

   factory.defineFunction(
       { id: 'kb-embed-document' },
       { event: 'ever.works/kb-embed-document' },
       async ({ event }) => {
           // operator-defined handler
       }
   );

   const plugin = new InngestJobRuntimePlugin()
       .useDispatchers({
           dispatchKbEmbedDocument: (payload) => factory.send('kb-embed-document', payload)
       })
       .useDispatcherFactory(factory);

   // Mount the Inngest serve handler at /api/inngest:
   export default serve({ client, functions: plugin.functions });
   ```

## Tenant overlay (EW-742)

> **SaaS only.** Per [`providers.md`](../../../docs/specs/features/tenant-job-runtime-overlay/providers.md), per-tenant BYO for Inngest is restricted to Inngest's SaaS offering. Self-host Inngest's signing-key isolation model isn't multi-tenant by design; the `available-providers` admin gate blocks self-host BYO at config time.

| Mode       | Behaviour                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `inherit`  | (default) Use the instance-default Inngest project keys.                                                   |
| `byo`      | Tenant supplies their own `eventKey` + `signingKey` (SaaS only).                                           |
| `override` | Same data plane as BYO (SaaS only).                                                                        |

### Tenant credential bag shape

```jsonc
{
    "eventKey": "...",     // per-tenant Inngest event key
    "signingKey": "..."    // per-tenant Inngest signing key
}
```

Surface on the view as `tenantEventKey` and `tenantSigningKey`.

### Per-tenant routing

Build one `Inngest` client per tenant project (using the tenant's `eventKey` + `signingKey`) and wrap each in its own factory. Thread per-tenant factories via `dispatchersBuilder`. Note that `serve()` is a single mount per process; per-tenant projects require either one process per project or a per-tenant subpath at the HTTP layer.

### Cross-references

- Tenant overlay spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
- Per-provider matrix: [`docs/specs/features/tenant-job-runtime-overlay/providers.md` § Inngest](../../../docs/specs/features/tenant-job-runtime-overlay/providers.md#inngest)
- ADR-017 (Inngest SaaS-only constraint): [`docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md`](../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
- Conformance suite: `src/__tests__/inngest-conformance.spec.ts` runs `runJobRuntimeContractSuite`.

## Local development

```bash
pnpm install
pnpm --filter @ever-works/job-runtime-inngest-plugin build
pnpm --filter @ever-works/job-runtime-inngest-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Inngest documentation](https://www.inngest.com/docs)
- [Plugin system](../../plugin/README.md)

## License

AGPL-3.0
