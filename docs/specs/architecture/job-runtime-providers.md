# Architecture: Job-Runtime Providers (pluggable background-job runtime)

**Status**: `In progress` — EW-685 P0 contract shipped (no behaviour change). EW-686 P1 (rehouse Trigger.dev as the `trigger` plugin) + binding factory + per-provider plugins remain.
**Last updated**: 2026-06-18
**Audience**: AI agents and engineers who need to understand how the platform's long-running work is dispatched, scheduled, cancelled, and executed — and how that runtime becomes a **swappable provider** (Trigger.dev default; Temporal / BullMQ / pg-boss / Inngest optional).

> This spec describes the **target architecture**. Nothing here is built yet. It generalises the existing [`trigger-integration`](./trigger-integration.md) and [`trigger-worker`](./trigger-worker.md) specs into a provider-neutral form. Read those two first — this spec assumes them. Decision rationale: [ADR-015](../decisions/015-job-runtime-provider-pluggability.md). Per-provider detail: [`features/job-runtime-providers/providers.md`](../features/job-runtime-providers/providers.md).

---

## 1. Purpose

Long-running operations (work generation, import, onboarding, scheduled dispatch, KB embedding, webhook delivery, agent heartbeats, deploy-ready polling, mission ticks) cannot run inside an HTTP request. Today they all run on **Trigger.dev SaaS**. This spec defines the **`job-runtime` capability**: a provider contract that lets a deployment choose _which_ runtime executes that work, while the rest of the platform — the API, the agent business logic, the dispatcher call sites — stays identical regardless of choice.

The runtime owns exactly six concerns, and **only** these six:

1. **Enqueue** — accept a typed payload and durably hand it to a worker.
2. **Schedule** — fire recurring/cron work (e.g. the schedule dispatcher every N minutes).
3. **Cancel** — abort an in-flight run by id.
4. **Status** — report run lifecycle (queued → running → completed/failed/cancelled) back so the API can mirror it onto `WorkGenerationHistory` etc.
5. **Retry / idempotency** — re-run safely with stable identity.
6. **Worker hosting** — run the process that executes `@ever-works/agent` orchestrators.

Everything else — what the work _does_, the SuperJSON callback channel, the pre-created `historyId`, secret hygiene — is provider-neutral and unchanged.

## 2. The seam that makes this possible

The platform already isolates the runtime behind **dispatcher interfaces** owned by the agent package. This is the entire reason a swap is tractable. Each is a tiny interface plus a DI `Symbol`:

```ts
// packages/agent/src/tasks/work-generation-dispatcher.ts (exists today)
export interface WorkGenerationDispatcher {
	dispatchWorkGeneration(payload: WorkGenerationPayload): Promise<string | null>;
	cancelWorkGeneration(runId: string): Promise<boolean>;
}
export const WORK_GENERATION_DISPATCHER = Symbol('WORK_GENERATION_DISPATCHER');
```

The API depends only on these symbols; it has **no** `@trigger.dev/sdk` import. `TriggerService` (`packages/tasks/src/trigger/trigger.service.ts`) implements all of them today. The eight dispatcher seams in use:

| Dispatcher symbol                                                                                                | Payload                        | Used by                 |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------- |
| `WORK_GENERATION_DISPATCHER`                                                                                     | `WorkGenerationPayload`        | `WorkGenerationService` |
| `WORK_IMPORT_DISPATCHER`                                                                                         | `WorkImportPayload`            | `WorkImportService`     |
| `TEMPLATE_CUSTOMIZATION_DISPATCHER`                                                                              | `TemplateCustomizationPayload` | template customization  |
| `WEBHOOK_DELIVERY_DISPATCHER`                                                                                    | `WebhookDeliveryPayload`       | webhook delivery        |
| `KB_MIRROR_DOCUMENT_DISPATCHER`                                                                                  | `KbMirrorDocumentPayload`      | KB mirror               |
| `KB_BACKFILL_SKELETON_DISPATCHER`                                                                                | `KbBackfillSkeletonPayload`    | KB backfill             |
| `KB_EMBED_DOCUMENT_DISPATCHER`                                                                                   | `KbEmbedDocumentPayload`       | KB embed                |
| `KB_ORG_OVERLAY_FANOUT_DISPATCHER`                                                                               | `KbOrgOverlayFanoutPayload`    | KB org overlay          |
| (+ `AGENT_TASK_EXECUTE_DISPATCHER`, `AGENT_CHAT_REPLY_DISPATCHER` wired in `apps/api/src/tasks/tasks.module.ts`) |                                | agents                  |

**The refactor's premise:** instead of binding these symbols to `TriggerService`, bind them to whichever `IJobRuntimeProvider` is active. Call sites do not change.

## 3. The `IJobRuntimeProvider` contract

A new capability `job-runtime` is registered in `packages/plugin/src/contracts/capabilities/`. A provider plugin extends `BasePlugin` (category `job-runtime`, `configurationMode: 'admin-only'`) and exposes:

```ts
// packages/plugin/src/contracts/capabilities/job-runtime.interface.ts (shipped in EW-685 P0)
export interface IJobRuntimeProvider {
	/** Stable provider id: 'trigger' | 'temporal' | 'bullmq' | 'pgboss' | 'inngest' */
	readonly runtimeId: JobRuntimeId;

	/** One object that implements every agent dispatcher interface (enqueue + cancel). */
	readonly dispatchers: JobRuntimeDispatchers;

	/** Register/lifecycle the recurring jobs the platform needs (cron). */
	registerSchedules(schedules: ScheduleSpec[]): Promise<void>;

	/** Cancel an in-flight run by the id returned at enqueue time. */
	cancel(runId: string): Promise<boolean>;

	/** Look up live run status (used where webhooks/callbacks aren't available). */
	getRunStatus(runId: string): Promise<JobRunStatus>;

	/** True when this provider is configured & reachable in the current env. */
	isEnabled(): boolean;

	/** Optional: stand up / connect the worker host (see §5). */
	startWorkerHost?(opts: WorkerHostOptions): Promise<WorkerHostHandle>;

	/**
	 * EW-686 P2 / EW-742 P3 — optional. Return a provider instance bound
	 * to the given tenant's credential snapshot (BYO/override mode).
	 * Returns `undefined` if the provider doesn't support BYO; the
	 * resolver falls back to the instance default with a `Logger.warn`.
	 * Implementations MUST memoise behind `credentialVersion` so repeat
	 * calls with the same snapshot return equivalent providers.
	 */
	bindToTenant?(snapshot: TenantCredentialSnapshot): IJobRuntimeProvider | undefined;
}

export interface TenantCredentialSnapshot {
	tenantId: string;
	providerId: JobRuntimeId;
	credentialVersion: number;
	credentials: Readonly<Record<string, unknown>>; // opaque, per-provider
}

export type JobRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface ScheduleSpec {
	id: string; // e.g. 'work-schedule-dispatcher'
	cron: string; // standard 5-field cron
	payload?: unknown; // optional static payload
}

export interface JobEnqueueOptions {
	tags?: string[];
	idempotencyKey?: string; // stable identity across retries
	concurrencyKey?: string; // serialise per key (e.g. per workId/orgId)
	maxDurationSeconds?: number;
	machineHint?: string; // provider maps to its own sizing
}
```

`JobRuntimeDispatchers` is the union of the existing dispatcher interfaces (`WorkGenerationDispatcher & WorkImportDispatcher & … `). The contract deliberately keeps the dispatch signature identical to today (`Promise<string | null>` — run id or "runtime disabled, fall back in-process").

### Design constraints the contract must hold

- **`string | null` enqueue return is preserved.** A disabled/unreachable runtime returns `null`; the API's existing in-process dev fallback is the provider-neutral safety net.
- **Idempotency is first-class.** The pre-created `historyId` already gives every dispatch a stable identity. Providers MUST map `idempotencyKey` onto their native mechanism (Trigger.dev `idempotencyKey`, Temporal workflow id, BullMQ/pg-boss job id, Inngest event idempotency) so retries write to the same `WorkGenerationHistory` row.
- **Concurrency keys are preserved.** Today some tasks are concurrency-keyed (KB mirror/embed on `workId`, org overlay on `organizationId`). The contract carries `concurrencyKey`; each provider maps it (Trigger.dev `queue.concurrencyKey`, BullMQ groups / job ids, Temporal workflow id namespacing, pg-boss singleton keys).
- **Cancellation must propagate an `AbortSignal` into the orchestrator** so in-flight AI/search/git calls abort — exactly as the Trigger.dev `onCancel`/`signal` path does today (see [`trigger-integration`](./trigger-integration.md) §8).

## 4. Selection: one active runtime per deployment, env-driven

Unlike per-user/per-work plugins (AI, search, deployment), the job runtime is **deployment infrastructure** — there is exactly **one** active runtime per deployment, chosen by the operator, scoped global/admin. This matches the `k8s` deployment plugin's `admin-only` config and ADR-005's cache/lock backend selection.

```bash
EVER_WORKS_JOB_RUNTIME=trigger   # trigger (default) | temporal | bullmq | pgboss | inngest
```

Binding (proposed) lives where the dispatcher symbols are provided. A factory reads `EVER_WORKS_JOB_RUNTIME`, resolves the matching registered `job-runtime` plugin from `PluginRegistryService`, and binds its `.dispatchers` to all `*_DISPATCHER` symbols:

```ts
// packages/agent/src/tasks/job-runtime.providers.ts (proposed shape)
const provider = jobRuntimeRegistry.getActive(); // by EVER_WORKS_JOB_RUNTIME
[
	WORK_GENERATION_DISPATCHER,
	WORK_IMPORT_DISPATCHER,
	TEMPLATE_CUSTOMIZATION_DISPATCHER,
	WEBHOOK_DELIVERY_DISPATCHER,
	KB_MIRROR_DOCUMENT_DISPATCHER,
	KB_BACKFILL_SKELETON_DISPATCHER,
	KB_EMBED_DOCUMENT_DISPATCHER,
	KB_ORG_OVERLAY_FANOUT_DISPATCHER
].forEach((sym) => bind(sym, () => provider.dispatchers));
```

Provider-specific credentials/options use the **standard plugin settings system** (`x-secret`, `x-envVar`, JSON-Schema, admin scope). The selector (`EVER_WORKS_JOB_RUNTIME`) is the only "which provider" knob; everything else is the chosen provider's settings.

```
┌──────────────────────────────────────────────────────────────┐
│ apps/api  — dispatch call sites depend ONLY on *_DISPATCHER    │
│            symbols (provider-neutral, unchanged)               │
└───────────────┬────────────────────────────────────────────────┘
                │  EVER_WORKS_JOB_RUNTIME selects ONE provider
        ┌───────┴────────┬─────────┬──────────┬──────────┐
        ▼                ▼         ▼          ▼          ▼
   trigger (default)  temporal   bullmq     pgboss    inngest
   SaaS / self-host   self/Cloud Redis      Postgres  SaaS only
        │                │         │          │          │
        ▼                ▼         ▼          ▼          ▼
   ┌────────────────────────────────────────────────────────────┐
   │ Worker host runs @ever-works/agent orchestrators            │
   │ (same SuperJSON callback channel to /internal/* for DB)     │
   └────────────────────────────────────────────────────────────┘
```

## 5. Worker-hosting models (the hard part)

Enqueue is the easy half. The genuinely different part is **how each runtime hosts and invokes the worker** that runs the agent orchestrators. The contract abstracts dispatch; it cannot fully abstract hosting, so each provider documents its model and ships its own worker entrypoint + deploy artifacts. The agent orchestrator code (`TriggerGenerationOrchestrator` → generalise to `JobOrchestrator`) and the SuperJSON callback channel are reused unchanged.

| Provider        | Worker-hosting model                                                                                                                                        | Who invokes the worker                          | Cron mechanism                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| **Trigger.dev** | Tasks deployed to Trigger.dev (`pnpm deploy:trigger`); Trigger.dev runs them on its machines (cloud or self-hosted).                                        | Trigger.dev platform                            | `schedules.task`                            |
| **Temporal**    | Long-running **Worker** process polls a task queue; we run it as a deployment/sidecar. Orchestrator = a Temporal **Workflow**; agent work = **Activities**. | Temporal Service hands tasks to polling workers | Temporal **Schedules** API                  |
| **BullMQ**      | In-process or sidecar `Worker` consuming a Redis queue; we run N worker replicas.                                                                           | The worker process pulls jobs from Redis        | BullMQ **repeatable jobs** (`JobScheduler`) |
| **pg-boss**     | In-process or sidecar pg-boss instance polling Postgres; `boss.work(name, handler)`.                                                                        | pg-boss polling Postgres                        | pg-boss **`schedule()`** (cron)             |
| **Inngest**     | Functions served over **HTTP** (`serve()` handler mounted in the API or a small service); **Inngest Cloud invokes them** via webhook.                       | Inngest Cloud calls our HTTP endpoint           | Inngest **cron functions**                  |

Key implications captured for the plan:

- **Trigger.dev and Inngest are "push" (the platform invokes our code)**; **Temporal/BullMQ/pg-boss are "pull" (our worker polls)**. The contract's optional `startWorkerHost()` exists for the pull model (Temporal/BullMQ/pg-boss start a long-lived worker); push providers (Trigger.dev, Inngest) implement it as a no-op or as the HTTP `serve()` mount.
- **The agent orchestrator must be runtime-agnostic.** Today it's `withWorkerContext()` + a NestJS application context bootstrap. That bootstrap is reused by every pull-model worker; the push-model providers wrap the same bootstrap inside their task/function handler.
- **Cancellation differs sharply.** Trigger.dev/Temporal have first-class cancel with signal propagation; BullMQ/pg-boss need a cooperative cancel (a cancellation flag the orchestrator polls at each `throwIfGenerationCancelled` checkpoint — the checkpoints already exist). Inngest cancels via its `cancelOn`/event model. The contract's `cancel(runId)` hides this; each provider implements it natively.
- **`maxDuration` (5h generation).** Trigger.dev supports it directly. Temporal supports arbitrarily long workflows. BullMQ/pg-boss have no hard cap but need lock-renewal/visibility-timeout tuning for multi-hour jobs (documented per provider). Inngest steps have per-step limits — long pipelines must be expressed as multiple steps.

## 6. Status reporting back to the API

Today the worker writes terminal state itself (orchestrator + `onFailure`/`onCancel`) and the API mirrors run ids. The contract keeps this: **the orchestrator remains the source of truth for `WorkGenerationHistory` status**, so most status flows are provider-neutral. `getRunStatus(runId)` is only needed where a provider lacks worker-side terminal writes or where the API polls (e.g. a future UI "live runtime status" panel). Providers that support webhooks (Trigger.dev, Inngest) may push status; pull providers expose `getRunStatus` by querying their store (BullMQ `Job.getState()`, pg-boss `getJobById`, Temporal `DescribeWorkflowExecution`).

## 7. Conformance suite (parity guarantee)

A provider-agnostic contract test in `packages/plugin/src/contracts/__tests__/` (type-level shape spec in `job-runtime.spec.ts` shipped EW-685 P0; runtime conformance `job-runtime.conformance.spec.ts` lands with the first concrete provider) exercises every provider identically (mirrors ADR-005's `LockProvider` contract suite):

- enqueue returns an id; the worker runs and writes terminal state
- idempotency: same `idempotencyKey` → one logical run, retries reuse the history row
- concurrency: same `concurrencyKey` serialises
- cancel: in-flight run aborts; orchestrator observes the signal/flag and writes `CANCELLED`
- schedule: a registered cron fires on cadence
- disabled/unreachable runtime: enqueue returns `null`, API falls back in-process (dev)

A provider is not "supported" until green on this suite. Until then it ships behind an `experimental` flag.

## 8. Configuration contract

Selector + per-provider settings (full matrix in [`providers.md`](../features/job-runtime-providers/providers.md)). Illustrative:

```bash
# Selector (default trigger — existing deployments need nothing)
EVER_WORKS_JOB_RUNTIME=trigger

# trigger  (unchanged — see trigger-integration.md §12)
TRIGGER_SECRET_KEY=...           TRIGGER_API_URL=https://api.trigger.dev
TRIGGER_INTERNAL_SECRET=...      TRIGGER_MACHINE=medium-1x

# temporal
TEMPORAL_ADDRESS=temporal.internal:7233   TEMPORAL_NAMESPACE=ever-works
TEMPORAL_TASK_QUEUE=ever-works-jobs
TEMPORAL_TLS_CERT / TEMPORAL_TLS_KEY      # for Temporal Cloud (mTLS)

# bullmq (Redis-only)
BULLMQ_REDIS_URL=redis://...     BULLMQ_PREFIX=ew  BULLMQ_CONCURRENCY=5

# pgboss (Postgres-native — can reuse the platform DB)
PGBOSS_DATABASE_URL=postgres://... (defaults to platform DATABASE_URL)
PGBOSS_SCHEMA=pgboss

# inngest (SaaS only)
INNGEST_EVENT_KEY=...   INNGEST_SIGNING_KEY=...   INNGEST_APP_ID=ever-works
```

The internal SuperJSON callback channel (`TRIGGER_INTERNAL_SECRET`, internal base URL) is **provider-neutral** — every pull-model worker still calls back to `/internal/*` over the same authenticated RPC. The env names may be generalised (`EVER_WORKS_INTERNAL_SECRET`) with the `TRIGGER_*` names kept as aliases for back-compat.

## 9. Coexistence & migration

- **Default path is byte-for-byte unchanged.** No `EVER_WORKS_JOB_RUNTIME` → `trigger`. The `trigger` provider IS the current `TriggerService`, re-housed.
- **Switching runtimes is a deploy-time action**, not a live migration. In-flight runs drain on the old runtime (or are re-enqueued idempotently). Documented in the per-provider deploy guide.
- **Self-hosted Trigger.dev** ([EW-592](https://evertech.atlassian.net/browse/EW-592)) = `trigger` provider with `TRIGGER_API_URL` pointed at the self-hosted instance. No new provider needed for that case.

## 10. File index

```
packages/plugin/src/contracts/capabilities/
└── job-runtime.interface.ts         # IJobRuntimeProvider, JobRunStatus, ScheduleSpec, options (shipped EW-685 P0)

packages/plugin/src/contracts/__tests__/
├── job-runtime.spec.ts              # type-level shape assertions (shipped EW-685 P0)
└── job-runtime.conformance.spec.ts  # runtime conformance suite (lands with first provider, EW-686 P1)

packages/agent/src/tasks/
├── *.dispatcher.ts                  # EXISTING dispatcher interfaces (unchanged)
└── job-runtime.providers.ts         # NEW factory: EVER_WORKS_JOB_RUNTIME → bind symbols (EW-685 P0 seam half, lands with EW-686 P1)

packages/plugins/
├── job-runtime-trigger/             # re-housed TriggerService (default)
├── job-runtime-temporal/            # @temporalio/* worker + workflows + activities
├── job-runtime-bullmq/              # bullmq Queue + Worker + JobScheduler
├── job-runtime-pgboss/              # pg-boss boss.work + schedule
└── job-runtime-inngest/             # inngest serve() + functions (SaaS)

packages/tasks/                      # remains the trigger provider's worker package
                                     # (other pull providers get sibling worker entrypoints)
```

## 11. Tenant-Scoped Overlay (multi-tenant extension)

This document defines the **instance-global** runtime selection (`EVER_WORKS_JOB_RUNTIME` chooses one provider per deployment). For multi-tenant deployments — Ever Works Cloud and any operator hosting multiple tenants on one instance — that single selection is the **fallback**; each tenant can layer an overlay on top to inherit, BYO credentials for the same provider, or override to a different _enabled_ provider. The overlay reuses the dispatcher seam from this doc unchanged — it plugs in via a `TenantAwareRuntimeResolver` placed in front of the EW-685 binding factory.

See the dedicated feature set for the overlay design:

- [ADR-017](../decisions/017-tenant-scoped-job-runtime-overlay.md) — decision + rationale.
- [`features/tenant-job-runtime-overlay/spec.md`](../features/tenant-job-runtime-overlay/spec.md) · [`plan.md`](../features/tenant-job-runtime-overlay/plan.md) · [`tasks.md`](../features/tenant-job-runtime-overlay/tasks.md) · [`providers.md`](../features/tenant-job-runtime-overlay/providers.md)
- Jira: [EW-742](https://evertech.atlassian.net/browse/EW-742) (epic) · [EW-743](https://evertech.atlassian.net/browse/EW-743) (P0 spec-kit story).

## 12. See Also

- [ADR-015](../decisions/015-job-runtime-provider-pluggability.md) — decision + rationale.
- [`features/job-runtime-providers/spec.md`](../features/job-runtime-providers/spec.md) · [`plan.md`](../features/job-runtime-providers/plan.md) · [`tasks.md`](../features/job-runtime-providers/tasks.md) · [`providers.md`](../features/job-runtime-providers/providers.md)
- [`trigger-integration.md`](./trigger-integration.md) · [`trigger-worker.md`](./trigger-worker.md) — the current integration, generalised here.
- [`plugin-sdk.md`](./plugin-sdk.md) — the plugin contract every provider extends.
- [ADR-005](../decisions/005-cache-and-lock-pluggability.md) — the sibling env-selected-backend pattern.
- [`features/scheduled-updates/spec.md`](../features/scheduled-updates/spec.md) — the CAS-claim contract the cron dispatcher relies on, runtime-neutral.
