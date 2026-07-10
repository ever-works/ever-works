# Adding a new dispatcher with T22 tenant runtime binding

> **Audience**: engineers adding a new `*_DISPATCHER` symbol (or a new
> Trigger.dev task) and want their enqueue → worker loop to participate
> in the EW-742 P3.2 T22 tenant runtime binding capture.
>
> **Status**: the 10 in-platform dispatchers landed on `main` per the
> table in `docs/specs/features/tenant-job-runtime-overlay/tasks.md`
> § "T22 (per-dispatcher wiring)". This runbook is the copy-paste
> template for dispatcher #11+.

## Why T22

The tenant-overlay system gives each tenant a `(providerId,
credentialVersion)` snapshot of which job-runtime engine + credentials
to use. T22 stamping captures that snapshot **at enqueue time** onto
the run's payload, then the worker host resolves it at run time to
either run with those credentials, skip-and-ack if the version was
rotated past (`'drained'`), or fall back to the instance default.

The whole loop is **fail-open per FR-5** — every absent dep / lookup
error ships `null/null` and the worker runs against the instance
default (byte-identical to the pre-overlay path).

## The 4 ingredients

| Ingredient                  | Where                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Payload type                | `packages/agent/src/tasks/<name>.types.ts`                                                                      |
| Dispatcher interface        | `packages/agent/src/tasks/<name>-dispatcher.ts`                                                                 |
| Producer (enqueue site)     | Wherever the service / event handler / API endpoint constructs the payload and calls `dispatcher.dispatch...()` |
| Consumer (Trigger.dev task) | `packages/tasks/src/tasks/trigger/<name>.task.ts`                                                               |

## Step 1 — extend the payload type

```ts
export interface Mb<Whatever>Payload {
    readonly workId: string;  // or organizationId / customizationId / subscriptionId
    // ... existing fields ...

    /**
     * EW-742 P3.2 T22 — enqueue-site tenant-runtime binding capture.
     * See `KbEmbedDocumentPayload` (the PoC dispatcher) for the full
     * contract; the same null/null fail-open semantics apply.
     */
    readonly providerId?: string | null;
    readonly credentialVersion?: number | null;
}
```

## Step 2 — wire stamper into the producer service

Inject `RuntimeBindingStamperService` as `@Optional()` and the
appropriate repository (`WorkRepository` / `OrganizationRepository` /
`TemplateCustomizationRepository` / `WebhookSubscriptionRepository`)
to resolve `tenantId` from the entity id on the payload:

```ts
constructor(
    // ... existing ...
    @Optional()
    private readonly runtimeBindingStamper?: RuntimeBindingStamperService,
    @Optional()
    private readonly workRepository?: WorkRepository,
) {}

private async stampForWork(workId: string) {
    if (!this.runtimeBindingStamper || !this.workRepository) {
        return { providerId: null, credentialVersion: null };
    }
    try {
        const work = await this.workRepository.findById(workId);
        return await this.runtimeBindingStamper.stamp(work?.tenantId ?? null);
    } catch (err) {
        this.logger.debug(
            `dispatch<name>: stamper lookup failed for work=${workId} ` +
                `(${(err as Error).message}); falling back to instance default.`,
        );
        return { providerId: null, credentialVersion: null };
    }
}
```

Then in the enqueue path:

```ts
const binding = await this.stampForWork(workId);
await this.dispatcher.dispatch<Name>({
	workId,
	// ... existing ...
	providerId: binding.providerId,
	credentialVersion: binding.credentialVersion
});
```

Make sure the producer module imports `TenantJobRuntimeModule` (it
provides `RuntimeBindingStamperService`).

## Step 3 — wire the worker task

The 4-line block at the top of the Trigger.dev task's `run()`:

```ts
import { TenantRuntimeBindingResolverService } from '../../trigger/worker/services/tenant-runtime-binding-resolver.service';

// inside run():
const binding = await appContext.get(TenantRuntimeBindingResolverService).resolveForWork(payload, payload.workId); // or resolveForOrganization / resolveForCustomization / resolveForSubscription
if (binding.status === 'drained') {
	logger.warn('<task-name>: credentials drained, skipping run', {
		workId: payload.workId,
		providerId: binding.providerId,
		credentialVersion: binding.credentialVersion,
		tenantId: binding.tenantId
	});
	return {
		status: 'skipped' as const,
		reason: 'credentials-drained' as const,
		workId: payload.workId
	};
}
// rest of the task...
```

### Picking the right resolver helper

| Payload field     | Helper                                                                     | Tenant lookup path                                                          |
| ----------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `workId`          | `resolveForWork(payload, workId)`                                          | `WorkRepository.findById → Work.tenantId`                                   |
| `organizationId`  | `resolveForOrganization(payload, organizationId)`                          | `OrganizationRepository.findById → Organization.tenantId`                   |
| `customizationId` | `resolveForCustomization(payload, customizationId)`                        | `TemplateCustomizationRepository.findById → TemplateCustomization.tenantId` |
| `subscriptionId`  | `resolveForSubscription(payload, subscriptionId)`                          | `WebhookSubscriptionRepository.findById → WebhookSubscription.tenantId`     |
| Anything else     | `resolve(payload, tenantId)` with task-specific tenantId resolution inline | varies                                                                      |

### Why skip-and-ack on `'drained'`?

`'drained'` means the tenant rotated their credentials past the
version stamped at enqueue. Retrying would just keep observing the
same drained state until the run hits the dead-letter queue. Every
task that's been wired so far is **idempotent** (re-running produces
the same final state), so skipping is safe — the next user action
(or the per-task reconciliation job, if one exists) picks the work
up against fresh credentials.

If your task is NOT idempotent, branch differently: log the drained
state and throw a typed error that Trigger.dev's retry policy
treats as terminal (drops to dead-letter on the first attempt).

## Step 4 — RPC plumbing (only if your repo isn't already proxied)

The worker-side resolver service consumes the host's repositories via
the existing remote-proxy controller (`apps/api/src/trigger/trigger-
internal.controller.ts`). If your new dispatcher's tenantId source is
a NEW repository not already in `remoteMap`, you need to:

1. Add the repository import + constructor injection on
   `TriggerInternalController`.
2. Add it to `remoteMap` in `onModuleInit()`.
3. Ensure the module that provides it is imported by
   `TriggerInternalModule` (or it transitively comes from
   `DatabaseModule`).
4. Add a `createRemoteProxy(apiClient, '<RepoName>')` provider in
   `packages/tasks/src/trigger/worker/modules/trigger-worker.module.ts`.
5. Extend `TenantRuntimeBindingResolverService`'s constructor with the
   new `@Optional()` repo and add a `resolveFor<Entity>(payload, id)`
   convenience wrapper.

See PR #1442 (org + customization) and #1445 (subscription) for the
exact diff shape.

## Step 5 — tests

`TenantRuntimeBindingResolverService` already has 24 vitest cases
covering every branch — if you reuse one of the 4 existing
convenience wrappers your task is implicitly covered. If you add a
new `resolveFor<Entity>` wrapper, mirror the 4 cases from the
existing wrappers (happy / missing repo / repo throws / missing
tenantId).

For the producer service, add 3-4 jest cases mirroring the existing
ones (e.g. `enqueueEmbed` cases in
`packages/agent/src/services/__tests__/knowledge-base.service.spec.ts`):

- happy path with overlay → stamper result threaded onto payload
- null tenantId → stamper called with null, ships null/null
- stamper throws → ships null/null (fail-open)
- repo throws (if applicable) → stamper never called, ships null/null

## Step 6 — when NOT to wire T22

Some dispatchers are intentionally tenant-agnostic. **Skip T22
stamping entirely** when:

- The payload semantically spans tenants (e.g. fleet-wide operator
  bootstrap scripts like `KB_BACKFILL_SKELETON` — `workIds: string[]`
  may cross tenants; stamping would be semantically incorrect).
- The task runs against platform-default credentials by design
  (cron sweeps, scheduled dispatchers).

In those cases, document the choice with a comment near the
dispatcher: `// EW-742 P3.2 T22 — intentionally out of scope:
fleet-wide ops use instance-default credentials by design.`

## References

- Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../specs/features/tenant-job-runtime-overlay/spec.md)
- Tasks: [`docs/specs/features/tenant-job-runtime-overlay/tasks.md`](../specs/features/tenant-job-runtime-overlay/tasks.md) (§ T22 has the full per-dispatcher PR table)
- ADR-017: [`docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md`](../specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
- Stamper helper: `packages/agent/src/tasks/runtime-binding-stamper.service.ts`
- Resolver service: `packages/tasks/src/trigger/worker/services/tenant-runtime-binding-resolver.service.ts`
- PoC dispatcher (kb-embed): `packages/agent/src/services/knowledge-base.service.ts` + `packages/tasks/src/tasks/trigger/kb-embed-document.task.ts`
