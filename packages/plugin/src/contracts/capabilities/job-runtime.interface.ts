import type { IPlugin } from '../plugin.interface.js';

/**
 * EW-683 / EW-685 P0 — pluggable background-job runtime providers.
 *
 * This is an **additive, contract-only** capability declaration. No call
 * site is wired through it yet. The `TriggerService` in
 * `packages/tasks/src/trigger/trigger.service.ts` remains the single concrete
 * binding for every `*_DISPATCHER` symbol exported from
 * `@ever-works/agent/tasks` — see [`docs/specs/architecture/job-runtime-providers.md`](../../../../docs/specs/architecture/job-runtime-providers.md)
 * §2 for the seam, §3 for this contract, and §5 for the per-provider
 * worker-hosting models that the optional `startWorkerHost` accommodates.
 *
 * Why ship the interface before any provider implements it:
 *
 *   - The cluster runtime keeps booting against Trigger.dev exactly as today.
 *   - EW-686 P1 ("rehouse Trigger.dev as the `trigger` job-runtime provider")
 *     becomes a focused refactor — implement this contract once against
 *     the existing `TriggerService`, no architectural surprises.
 *   - EW-742 P3+ (tenant-aware dispatcher resolver) gets the type it
 *     needs to express "the active provider for this `(tenantId, jobName)`
 *     pair" without further plugin-package churn.
 *   - The conformance suite plan in §7 of the architecture spec gets a
 *     stable target signature to test against.
 *
 * Capability strings a `job-runtime` plugin manifest declares (mirror
 * what `dns.interface.ts` does for DNS plugins):
 *   - `job-runtime-enqueue` (required) — produce a `runId` (or `null`)
 *   - `job-runtime-cancel` (required) — abort an in-flight run
 *   - `job-runtime-status` (required) — read live run lifecycle
 *   - `job-runtime-schedule` (required) — register cron-like recurrence
 *   - `job-runtime-worker-host` (optional) — pull-model worker hosting
 *
 * The single selector knob (one runtime per deployment) lives at
 * `EVER_WORKS_JOB_RUNTIME=trigger|temporal|bullmq|pgboss|inngest` per
 * §4 of the architecture spec. Tenant-scoped overlay on top of that is
 * the EW-742 epic.
 *
 * Design constraints carried from the architecture spec into the
 * contract shape (§3 "Design constraints the contract must hold"):
 *
 *   - **`string | null` enqueue return is preserved.** A disabled or
 *     unreachable runtime returns `null`; the API's existing in-process
 *     dev fallback is the provider-neutral safety net.
 *   - **Idempotency is first-class** via `JobEnqueueOptions.idempotencyKey`.
 *     Providers map it onto their native mechanism (Trigger.dev
 *     `idempotencyKey`, Temporal workflow id, BullMQ/pg-boss job id,
 *     Inngest event idempotency) so retries reuse the original
 *     `WorkGenerationHistory` row.
 *   - **Concurrency keys are preserved** via `concurrencyKey`. Today
 *     KB mirror/embed serialise on `workId` and org overlay on
 *     `organizationId`; the contract carries this through.
 *   - **Cancellation must propagate an `AbortSignal` into the
 *     orchestrator** so in-flight AI/search/git calls abort — exactly
 *     as the Trigger.dev `onCancel`/`signal` path does today. The
 *     dispatcher contract owns the cancel-request side; the
 *     orchestrator-side `AbortSignal` plumbing is per-worker-host code
 *     (P4 / EW-748) and not part of this interface.
 */

/**
 * Canonical id of the currently-supported job-runtime providers. Kept
 * as a string-literal union (NOT a runtime enum) so plugin packages can
 * declare their `runtimeId` without importing a runtime symbol from
 * `@ever-works/plugin`. The selector env var `EVER_WORKS_JOB_RUNTIME`
 * accepts these and only these values; unknown values fall back to
 * `trigger` (the default).
 */
export type JobRuntimeId = 'trigger' | 'temporal' | 'bullmq' | 'pgboss' | 'inngest';

/**
 * Run lifecycle states observable via `getRunStatus(runId)`. Providers
 * map their native state machine onto this 6-value union. `'unknown'`
 * is the fallback when a provider can't resolve a runId — typically
 * because the run has been pruned past retention or the runId is from
 * a different provider entirely.
 */
export type JobRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

/**
 * One recurring job. The provider's `registerSchedules` translates each
 * spec into its native cron mechanism (Trigger.dev `schedules.task`,
 * Temporal Schedules API, BullMQ repeatable jobs, pg-boss `schedule()`,
 * Inngest cron functions).
 */
export interface ScheduleSpec {
	/** Stable id, e.g. `work-schedule-dispatcher`. Drives idempotent re-registration. */
	readonly id: string;
	/** Standard 5-field cron expression. */
	readonly cron: string;
	/** Optional static payload handed to the job on every fire. */
	readonly payload?: unknown;
}

/**
 * Per-enqueue knobs the call site can supply. All optional — sensible
 * defaults applied per-provider when absent. Anything that affects
 * idempotency / concurrency / cost / tenant routing belongs here;
 * payload shape itself stays in the typed per-job `*_DISPATCHER`
 * interface.
 */
export interface JobEnqueueOptions {
	/** Arbitrary tags for observability / filtering in the provider UI. */
	readonly tags?: readonly string[];
	/** Stable identity across retries — providers map onto their native idempotency. */
	readonly idempotencyKey?: string;
	/** Serialise per key (e.g. per `workId` for KB embed). */
	readonly concurrencyKey?: string;
	/** Hard upper bound on run wall-clock; providers cap at their own ceiling. */
	readonly maxDurationSeconds?: number;
	/** Provider-specific sizing hint (Trigger.dev machine preset, BullMQ priority lane, …). */
	readonly machineHint?: string;
	/**
	 * EW-742 P4 / T31 — owning tenant id. When set, the worker host MUST
	 * route this run against the tenant's overlay binding (the
	 * `(providerId, credentialVersion)` snapshot resolved by
	 * `TenantAwareRuntimeResolver` + stamped by
	 * `RuntimeBindingStamperService` at enqueue time). When unset, the
	 * run executes against the instance default — byte-identical to the
	 * EW-683 pre-tenancy path.
	 *
	 * Per-provider routing semantic (per [`providers.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/providers.md)):
	 *   - Trigger.dev: `metadata.tenantId` → tenant webhook handler
	 *     dispatches against the right BYO project.
	 *   - Inngest: `data.tenantId` → tenant webhook handler with the
	 *     right signing key (SaaS only — self-host blocked at
	 *     `available-providers`).
	 *   - Temporal: `searchAttributes.tenantId` (also encoded into the
	 *     namespace selection at start-workflow time — Q1
	 *     namespace-per-tenant).
	 *   - BullMQ: `opts.tenantId` (writeable via `JobsOptions`); used
	 *     for Redis prefix isolation per tenant worker.
	 *   - pg-boss: payload field; the per-tenant schema lookup happens
	 *     before publish (Q2 schema-per-tenant).
	 *
	 * Type stays `string` (uuid in practice) rather than a branded type
	 * to avoid forcing every dispatcher caller to import a contracts
	 * package; the API resolves it from the auth session and passes it
	 * through.
	 */
	readonly tenantId?: string;
}

/**
 * Worker-host options for the pull model. Push-model providers
 * (Trigger.dev, Inngest) implement `startWorkerHost` as a no-op or as
 * the HTTP `serve()` mount; pull-model providers (Temporal, BullMQ,
 * pg-boss) start a long-lived worker process. Returned handle exposes
 * a `stop()` for graceful shutdown coordination.
 */
export interface WorkerHostOptions {
	/** Concurrency cap for the worker process. Provider-specific defaults if omitted. */
	readonly concurrency?: number;
	/** Optional polling tuning (only meaningful for pull-model providers). */
	readonly pollIntervalMs?: number;
	/** Optional abort signal so process-level shutdown propagates cooperatively. */
	readonly signal?: AbortSignal;
}

export interface WorkerHostHandle {
	/** Stop polling / draining and release resources. Idempotent. */
	stop(): Promise<void>;
}

/**
 * EW-686 P2 / EW-742 — opaque per-tenant credential snapshot handed to a
 * provider's `bindToTenant` hook. The platform resolves the snapshot from
 * `tenant_job_runtime_config` + the secrets store; the provider treats the
 * `credentials` bag as opaque material to thread into its own client
 * constructor (Trigger.dev access token, Temporal mTLS cert, BullMQ Redis
 * URL, pg-boss connection string, Inngest signing key — shape is
 * per-provider).
 *
 * The `credentialVersion` field is monotonic per `(tenantId, providerId)`
 * — it bumps on every rotate / force-invalidate (see ADR-017 §3 / Q4).
 * Providers use it as a memoisation key on the returned binding so a
 * repeated `bindToTenant` call with the same snapshot returns the same
 * provider instance.
 */
export interface TenantCredentialSnapshot {
	/** Tenant id (uuid). */
	readonly tenantId: string;
	/** Provider id this snapshot is for (matches IJobRuntimeProvider.runtimeId). */
	readonly providerId: JobRuntimeId;
	/** Monotonic per-tenant version — bumps on rotate / force-invalidate. */
	readonly credentialVersion: number;
	/** Opaque credential bag — shape is per-provider. */
	readonly credentials: Readonly<Record<string, unknown>>;
}

/**
 * Union of the existing dispatcher interfaces a `job-runtime` provider
 * must implement to bind into the `*_DISPATCHER` symbols.
 *
 * **Deliberately untyped here.** The concrete dispatcher interfaces
 * (`WorkGenerationDispatcher`, `KbEmbedDocumentDispatcher`, …) live in
 * `@ever-works/agent/tasks`, which already depends on
 * `@ever-works/plugin`. Importing them back into this contract file
 * would introduce a package-dependency cycle (plugin → agent → plugin).
 *
 * Provider implementations should:
 *   1. Declare their `dispatchers` field with the full intersection
 *      type, importing it from `@ever-works/agent/tasks` (downstream
 *      packages already depend on agent, so the cycle stays one-way).
 *   2. Satisfy the structural shape — every `*_DISPATCHER` symbol in
 *      `_tasks-symbols.ts` has a corresponding `dispatchXxx` method.
 *
 * The conformance suite (P6 / EW-750) is what enforces "every
 * dispatcher symbol gets a binding" — this contract just opens the
 * door for the binding to exist.
 */
export type JobRuntimeDispatchers = Readonly<Record<string, unknown>>;

/**
 * The capability surface a `job-runtime` plugin contributes. Sized to
 * exactly the six concerns in §1 of the architecture spec (enqueue,
 * schedule, cancel, status, retry/idempotency, worker hosting).
 *
 * `IJobRuntimeProvider` extends `IPlugin` because a job-runtime is
 * registered through the standard plugin pipeline (manifest →
 * `PluginRegistryService` → DI binding). The selector
 * (`EVER_WORKS_JOB_RUNTIME`) picks one registered provider; the rest
 * stay inert but loaded so a hot-swap stays cheap.
 */
export interface IJobRuntimeProvider extends IPlugin {
	/** Stable provider id matching the `EVER_WORKS_JOB_RUNTIME` selector value. */
	readonly runtimeId: JobRuntimeId;

	/**
	 * One object that implements every agent dispatcher interface
	 * (enqueue + cancel for each job type). Bound into the
	 * `*_DISPATCHER` DI symbols by the binding factory in
	 * `packages/agent/src/tasks/job-runtime.providers.ts` (P0
	 * scaffolding, P1 wiring per EW-686).
	 */
	readonly dispatchers: JobRuntimeDispatchers;

	/**
	 * Register or refresh the recurring jobs the platform needs. Called
	 * once at boot (and again on hot-config-reload). MUST be idempotent
	 * — re-registering an existing `id` updates its cron expression
	 * in-place rather than spawning a duplicate.
	 */
	registerSchedules(schedules: readonly ScheduleSpec[]): Promise<void>;

	/**
	 * Cancel an in-flight run by the id returned at enqueue time.
	 * Returns `true` when the cancellation was accepted by the
	 * provider (not necessarily when the orchestrator has actually
	 * observed the abort signal). Returns `false` for unknown/already-
	 * terminal runIds.
	 */
	cancel(runId: string): Promise<boolean>;

	/**
	 * Look up live run lifecycle. Used where webhooks/callbacks aren't
	 * available (CLI status command, future "live runtime status" UI
	 * panel). Returns `'unknown'` for unresolvable runIds rather than
	 * throwing — callers treat unknown as "stale, try DB instead".
	 */
	getRunStatus(runId: string): Promise<JobRunStatus>;

	/**
	 * True when this provider is configured and reachable in the
	 * current environment. The binding factory calls this at boot;
	 * `false` triggers fallback to the in-process dev path so the API
	 * never refuses to start because (e.g.) Trigger.dev credentials
	 * weren't supplied to a local-dev container.
	 */
	isEnabled(): boolean;

	/**
	 * Optional: stand up / connect the worker host. Pull-model
	 * providers (Temporal, BullMQ, pg-boss) start a long-lived worker;
	 * push-model providers (Trigger.dev, Inngest) implement as a no-op
	 * or as their HTTP `serve()` mount. Absent on providers that
	 * don't need it.
	 */
	startWorkerHost?(opts: WorkerHostOptions): Promise<WorkerHostHandle>;

	/**
	 * EW-686 P2 / EW-742 P3 — return a provider instance bound to the
	 * given tenant's credential snapshot. The default
	 * `IJobRuntimeProvider` implementation uses the operator-supplied
	 * platform credentials; when a tenant opts into BYO/override mode
	 * (EW-742), the tenant-aware resolver calls this method to swap in
	 * a tenant-scoped client without mutating the shared singleton.
	 *
	 * Optional: a provider that doesn't support BYO returns `undefined`
	 * and the resolver falls back to the instance default with a
	 * `Logger.warn`. Push-model providers (Trigger.dev, Inngest)
	 * implement this by returning a copy with the credential client
	 * re-configured against the tenant secret. Pull-model providers
	 * (Temporal, BullMQ, pg-boss) implement it by returning a copy
	 * bound to the per-tenant namespace/queue/schema.
	 *
	 * Idempotency: calling `bindToTenant` with the same snapshot twice
	 * MUST return equivalent providers (same `dispatchers`, same
	 * `runtimeId`); implementations should memoise behind a
	 * `credentialVersion` key.
	 *
	 * The returned `IJobRuntimeProvider` is a TRANSIENT VIEW — callers
	 * must NOT register it in the provider registry. The original
	 * singleton is the only thing the registry holds.
	 */
	bindToTenant?(snapshot: TenantCredentialSnapshot): IJobRuntimeProvider | undefined;
}
