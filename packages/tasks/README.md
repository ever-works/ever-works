# @ever-works/trigger-tasks

Background job definitions for Ever Works powered by [Trigger.dev](https://trigger.dev). This package contains the task implementations that execute long-running work asynchronously: AI generation, content extraction, screenshotting, scheduled re-fetches, deployments, and so on.

> **Private package.** Used internally by the platform; not published to npm.

## Overview

The Ever Works API enqueues jobs that this package picks up and runs in a Trigger.dev worker. Most tasks are thin orchestration layers that delegate to services in [`@ever-works/agent`](../agent) — the worker brings in the same NestJS modules so business logic is shared between the API and the workers.

```
┌────────────┐  enqueue   ┌──────────────────┐  pull   ┌────────────────────┐
│  apps/api  │ ─────────> │  Trigger.dev     │ ──────> │ @ever-works/       │
│            │            │  cloud queue     │         │ trigger-tasks      │
└────────────┘            └──────────────────┘         └────────────────────┘
                                                                │
                                                                ▼
                                                       @ever-works/agent
                                                       (work-operations,
                                                        items-generator,
                                                        pipeline, …)
```

## Tasks

The package defines tasks for:

- Work generation and regeneration
- Item-level operations (enrichment, content extraction, screenshots)
- Scheduled work updates
- Deployment workflows
- Community PR processing
- Notifications and emails

Tasks are registered with Trigger.dev via [`trigger.config.ts`](./trigger.config.ts).

## Local development

```bash
# Run the Trigger.dev dev server
pnpm dev:trigger
# (equivalent to: cd packages/tasks && pnpm dev:trigger)
```

## Build & deploy

```bash
# Build the package
pnpm --filter @ever-works/trigger-tasks build

# Bundle plugins for the worker (built artifacts)
pnpm --filter @ever-works/trigger-tasks prepare:plugins

# Deploy tasks to Trigger.dev
pnpm deploy:trigger
```

`prepare:plugins` runs before deployment to make sure every plugin in [`packages/plugins/*`](../plugins) is built and copied into the worker bundle.

## Environment

Trigger.dev credentials and project configuration are read from the standard Trigger.dev environment variables. See [trigger.config.ts](./trigger.config.ts) and the [Trigger.dev docs](https://trigger.dev/docs).

## Tenant overlay (EW-742)

This package houses the `TriggerJobRuntimeProvider` adapter — the Trigger.dev arm of the tenant-scoped job-runtime overlay defined in [`docs/specs/features/tenant-job-runtime-overlay/`](../../docs/specs/features/tenant-job-runtime-overlay/spec.md). The adapter (`src/trigger/trigger-job-runtime.provider.ts`) wraps the existing `TriggerService` and exposes it through the full `IJobRuntimeProvider` contract so it slots into the binding factory alongside the four `packages/plugins/job-runtime-*` providers.

| Mode       | Behaviour                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `inherit`  | (default) Use the instance-default Trigger.dev project credentials. Byte-identical to the pre-overlay path.                                 |
| `byo`      | Tenant supplies their own Trigger.dev project access token; `bindToTenant` returns a view configured to dispatch into the tenant's project. |
| `override` | Same data plane as BYO; differs only by intent.                                                                                             |

**Per-tenant routing constraint:** Trigger.dev's REST API can read prod secret keys but cannot create new projects programmatically. BYO mode therefore requires either operator-side worker self-registration or a tenant dashboard manual-paste workflow. See [`docs/specs/features/tenant-job-runtime-overlay/providers.md` § Trigger.dev](../../docs/specs/features/tenant-job-runtime-overlay/providers.md#triggerdev) for the operational details.

**Conformance:** `src/trigger/__tests__/trigger-conformance.spec.ts` runs the shared `runJobRuntimeContractSuite` from `@ever-works/plugin/contracts-conformance` against `TriggerJobRuntimeProvider`. All 11 contract invariants pass.

**Cross-references:**

- Tenant overlay spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
- Per-provider matrix: [`docs/specs/features/tenant-job-runtime-overlay/providers.md`](../../docs/specs/features/tenant-job-runtime-overlay/providers.md)
- ADR-017: [`docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md`](../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Repository](https://github.com/ever-works/ever-works)
- [Trigger.dev docs](https://trigger.dev/docs)
- [`@ever-works/agent`](../agent) — domain logic invoked by tasks

## License

UNLICENSED — internal package, not for external distribution.
