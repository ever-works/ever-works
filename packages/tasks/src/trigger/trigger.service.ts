import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { configure, runs, tasks } from '@trigger.dev/sdk';
import { config } from '@ever-works/agent/config';
import {
    WorkGenerationPayload,
    WorkGenerationDispatcher,
    WorkImportPayload,
    WorkImportDispatcher,
    TemplateCustomizationPayload,
    TemplateCustomizationDispatcher,
    RosterProvisionPayload,
    RosterProvisionDispatcher,
    WebhookDeliveryPayload,
    WebhookDeliveryDispatcher,
    KbMirrorDocumentPayload,
    KbMirrorDocumentDispatcher,
    KbBackfillSkeletonPayload,
    KbBackfillSkeletonDispatcher,
    KbEmbedDocumentPayload,
    KbEmbedDocumentDispatcher,
    KbOrgOverlayFanoutPayload,
    KbOrgOverlayFanoutDispatcher,
    KbNormalizeMediaPayload,
    KbNormalizeMediaDispatcher,
    KbTranscribePayload,
    KbTranscribeDispatcher,
    KbReembedWorkPayload,
    KbReembedWorkDispatcher,
    WorkspaceBackupPayload,
    WorkspaceBackupDispatcher,
    MemoryFactEmbedPayload,
    MemoryFactEmbedDispatcher,
    AppDependencyProvisionPayload,
    AppDependencyProvisionDispatcher,
    // APW-03 T13 — the `app-spec-evaluate` payload, re-exported by the agent
    // package's tasks barrel. (APW-02 T28 wires the dispatch below.)
    AppSpecEvaluatePayload,
    // APW-05 T18 — the two Build dispatchers, their payloads and the runtime-neutral
    // job ids they are enqueued under (plan §7.1:1312-1319). The ids come from the
    // agent barrel rather than being re-typed here, so the dispatch site and the task
    // modules can never disagree about the string on the wire.
    AppBuildPreparePayload,
    AppBuildPrepareDispatcher,
    AppBuildWatchPayload,
    AppBuildWatchDispatcher,
    APP_BUILD_PREPARE_TASK_ID,
    APP_BUILD_WATCH_TASK_ID,
    // EW-693 / T27 — the long-running plugin operation job, named once in the agent.
    PLUGIN_OPERATION_QUEUE_TTL_SECONDS,
    PLUGIN_OPERATION_TASK_ID,
    type PluginOperationPayload,
} from '@ever-works/agent/tasks';
import type {
    JobRunResult,
    JobRunStatus,
    JobRuntimeDispatchers,
    JobRuntimeId,
    ScheduleSpec,
    WorkerHostHandle,
    WorkerHostOptions,
} from '@ever-works/plugin';
import { workGenerationTask } from '../tasks/trigger/work-generation.task';
import { workImportTask } from '../tasks/trigger/work-import.task';
import { templateCustomizationTask } from '../tasks/trigger/template-customization.task';
import { rosterProvisionTask } from '../tasks/trigger/roster-provision.task';
import { webhookDeliveryTask } from '../tasks/trigger/webhook-delivery.task';
import { kbMirrorDocumentTask } from '../tasks/trigger/kb-mirror-document.task';
import { kbBackfillSkeletonTask } from '../tasks/trigger/kb-backfill-skeleton.task';
import { kbEmbedDocumentTask } from '../tasks/trigger/kb-embed-document.task';
import { kbOrgOverlayFanoutTask } from '../tasks/trigger/kb-org-overlay-fanout.task';
import { kbNormalizeVideoTask } from '../tasks/trigger/kb-normalize-video.task';
import { kbNormalizeAudioTask } from '../tasks/trigger/kb-normalize-audio.task';
import { kbTranscribeTask } from '../tasks/trigger/kb-transcribe.task';
import { kbReembedWorkTask } from '../tasks/trigger/kb-reembed-work.task';
import { memoryFactEmbedTask } from '../tasks/trigger/memory-fact-embed.task';
import { notificationChannelDeliveryTask } from '../tasks/trigger/notification-channel-delivery.task';
import { workspaceBackupTask } from '../tasks/trigger/workspace-backup.task';
import { appDependencyProvisionTask } from '../tasks/trigger/app-dependency-provision.task';
// APW-03 T13's job — dispatched by `dispatchAppSpecEvaluate` below (APW-02 T28).
import { appSpecEvaluateTask } from '../tasks/trigger/app-spec-evaluate.task';
// APW-05 T18 — the `app-build-prepare` job, reached by ID below rather than through its
// handle, so a TYPE-only import is all this file needs from it: the generic type argument
// on `tasks.trigger<…>` is what keeps the payload checked at compile time. The job id
// itself comes from `@ever-works/agent/tasks` (`APP_BUILD_PREPARE_TASK_ID`), which is the
// same string that module registers its task under.
import type { appBuildPrepareTask } from '../tasks/trigger/app-build-prepare.task';
// APW-06 T32 — the `app-deploy` one-shot. Imported as a VALUE (unlike the two
// Build tasks above, which are reached by id) because this dispatcher passes no
// `queue` of its own: the task declares `APP_RUNTIME_TASK_QUEUE` and its
// two-hour `maxDuration`, and triggering the object keeps both with the task
// instead of restating them at every call site.
import { appDeployTask, type AppDeployTaskPayload } from '../tasks/trigger/app-deploy.task';
// C10 — the `app-fork-readiness` job (APW-02 plan §6.1/§6.2). Both the id and the type
// come from the task module itself here: T31's planned agent-side
// `app-fork-readiness.types.ts` has not landed, and unlike the Build pair there is no
// second declaration to keep in step — the id is imported, never re-typed, so the
// dispatch site and the `task({ id })` registration cannot disagree.
import {
    APP_FORK_READINESS_TASK_ID,
    type appForkReadinessTask,
} from '../tasks/trigger/app-fork-readiness.task';
import type { runPluginOperationTask } from '../tasks/trigger/run-plugin-operation.task';
import type { NotificationChannelDeliveryPayload } from '@ever-works/agent/facades';
// C10 — the readiness payload and dispatcher contract T23 declared (provisionally) in
// `app-upstream-state.service.ts`, imported as a TYPE only: the service that produces the
// payload is API-side, and this file only needs the shape the SDK call is checked against.
import type { AppForkReadinessJobPayload } from '@ever-works/agent/app-works';

/**
 * EW-742 P3.2 T22 (stamping) — minimal stamp payload set on the
 * thread-local store by {@link TriggerJobRuntimeProvider}'s per-tenant
 * Proxy view of {@link TriggerService.dispatchers}.
 *
 * Each tenant-scoped `dispatchXxx` method on {@link TriggerService}
 * reads this store via {@link TriggerService.currentTenantStamp} and
 * merges:
 *   - `concurrencyKey`: composed with any existing key so the
 *     dispatcher's per-workId / per-orgId serialization invariant is
 *     preserved AND the queue still partitions per tenant.
 *   - `tags`: prepended with `tenant:${tenantId}` for Trigger.dev
 *     dashboard filtering.
 *
 * Fleet-wide dispatchers (operator bootstrap like
 * `dispatchKbBackfillSkeleton`) intentionally do NOT call the helper
 * — they run as platform scope.
 *
 * Idempotency: `idempotencyKey`, if set by the caller, takes
 * precedence and is never derived from the tenant id (would silently
 * promote a per-tenant idempotency window to a global one).
 */
export interface TriggerTenantStamp {
    readonly tenantId: string;
}

/**
 * Process-local store the {@link TriggerJobRuntimeProvider} per-tenant
 * view writes the {@link TriggerTenantStamp} into for the duration of
 * a single dispatch call. Module-level so the {@link TriggerService}
 * method can read it without a per-call argument plumbing change
 * (keeps every existing call site untouched).
 *
 * Exported so the binding-layer Proxy can call `.run(stamp, () =>
 * method.apply(...))` without depending on a TriggerService instance
 * member.
 */
export const triggerTenantStampStorage = new AsyncLocalStorage<TriggerTenantStamp>();

// APW-05 T18 — the two Build dispatchers below. They carry the same `string | null`
// contract and the same tenant stamping as every sibling here; `null` is what §7.1's
// in-process fallback keys on.
@Injectable()
export class TriggerService
    implements
        WorkGenerationDispatcher,
        WorkImportDispatcher,
        TemplateCustomizationDispatcher,
        RosterProvisionDispatcher,
        WebhookDeliveryDispatcher,
        KbMirrorDocumentDispatcher,
        KbBackfillSkeletonDispatcher,
        KbEmbedDocumentDispatcher,
        KbOrgOverlayFanoutDispatcher,
        KbNormalizeMediaDispatcher,
        KbTranscribeDispatcher,
        KbReembedWorkDispatcher,
        WorkspaceBackupDispatcher,
        MemoryFactEmbedDispatcher,
        AppDependencyProvisionDispatcher,
        AppBuildPrepareDispatcher,
        AppBuildWatchDispatcher
{
    private readonly logger = new Logger(TriggerService.name);
    private configured = false;

    /**
     * EW-686 P1 (first sub-step) — structural conformance with
     * `IJobRuntimeProvider` from
     * `packages/plugin/src/contracts/capabilities/job-runtime.interface.ts`.
     *
     * Deliberately NOT `implements IJobRuntimeProvider` yet — that
     * interface extends `IPlugin`, which would force `TriggerService` to
     * also expose `id` / `name` / `version` / `category` / `capabilities` /
     * `settingsSchema` / `onLoad` / `onUnload`. Adding the full `IPlugin`
     * surface to this concrete class belongs in a follow-up sub-PR (either
     * via `implements IJobRuntimeProvider` once a manifest stub is in
     * place, or via a thin adapter class that wraps this service). For
     * now the `*_DISPATCHER` symbols keep their existing `useExisting:
     * TriggerService` bindings — no call sites change — and the binding
     * factory landing in a later sub-PR can already consume the structural
     * `IJobRuntimeProvider` shape via duck typing.
     *
     * The 6 fields/methods below mirror §3 of
     * `docs/specs/architecture/job-runtime-providers.md` exactly:
     *   - `runtimeId`            (selector match)
     *   - `dispatchers`          (the `*_DISPATCHER` bag)
     *   - `isEnabled()`          (reachability gate)
     *   - `cancel()`             (provider-side abort)
     *   - `getRunStatus()`       (lifecycle read)
     *   - `registerSchedules()`  (cron registration)
     *   - `startWorkerHost?()`   (push-model no-op for Trigger.dev)
     */
    readonly runtimeId: JobRuntimeId = 'trigger';

    /**
     * `TriggerService` IS the dispatcher bag — it already implements
     * every `*Dispatcher` interface exported from `@ever-works/agent/tasks`
     * (WorkGeneration, WorkImport, TemplateCustomization, WebhookDelivery,
     * KbMirrorDocument, KbBackfillSkeleton, KbEmbedDocument,
     * KbOrgOverlayFanout, KbNormalizeMedia, KbTranscribe, KbReembedWork
     * + notification channel delivery). The cast through `unknown` is required because
     * the contract's {@link JobRuntimeDispatchers} type is intentionally
     * the opaque `Readonly<Record<string, unknown>>` shape — see the
     * JSDoc on `JobRuntimeDispatchers` in the contract file for the
     * `plugin → agent → plugin` cycle-avoidance rationale.
     */
    readonly dispatchers: JobRuntimeDispatchers = this as unknown as JobRuntimeDispatchers;

    private supportedMachines = [
        'medium-1x',
        'micro',
        'small-1x',
        'small-2x',
        'medium-2x',
        'large-1x',
        'large-2x',
    ];

    private ensureConfigured(): boolean {
        if (!config.trigger.shouldUseTrigger()) {
            return false;
        }

        if (this.configured) {
            return true;
        }

        const accessToken = config.trigger.getSecretKey();
        const baseURL = config.trigger.getApiUrl();

        if (!accessToken) {
            this.logger.warn('TRIGGER_SECRET_KEY is not configured');
            return false;
        }

        configure({ accessToken, baseURL });
        this.configured = true;
        return true;
    }

    /**
     * EW-686 P1 — public `IJobRuntimeProvider.isEnabled()` view of the
     * existing `ensureConfigured()` gate. Returns `true` when
     * `shouldUseTrigger()` is true AND a `TRIGGER_SECRET_KEY` is present
     * (the same gate every `dispatchXxx` method already uses internally).
     *
     * Side-effects are intentional and harmless: the first call lazily
     * runs `configure({ accessToken, baseURL })` against `@trigger.dev/sdk`,
     * identical to what the first dispatch would have done; subsequent
     * calls are a cheap boolean read.
     */
    isEnabled(): boolean {
        return this.ensureConfigured();
    }

    /**
     * EW-686 P1 — provider-side cancellation of an in-flight Trigger.dev
     * run by run id. Mirrors the existing {@link cancelWorkGeneration}
     * shape (single `runs.cancel(runId)` SDK call, errors swallowed and
     * logged, `false` on failure).
     *
     * Returns `true` when Trigger.dev accepted the cancel request — not
     * necessarily when the orchestrator has observed the abort signal
     * (worker-side abort is a separate concern, unchanged here). Returns
     * `false` when the runtime is disabled OR the SDK call threw
     * (typically unknown / already-terminal run ids).
     */
    async cancel(runId: string): Promise<boolean> {
        if (!this.ensureConfigured()) {
            return false;
        }

        try {
            await runs.cancel(runId);
            return true;
        } catch (error) {
            this.logger.warn(`Failed to cancel Trigger.dev run ${runId}: ${error}`);
            return false;
        }
    }

    /**
     * EW-686 P1 — look up live lifecycle of a Trigger.dev run. Returns
     * `'unknown'` when the runtime is disabled OR the run id can't be
     * resolved (pruned past retention, cross-provider run id, network
     * error) — per the contract, callers treat `'unknown'` as "stale,
     * try DB instead" rather than as a hard failure.
     *
     * Mapping is driven by the actual `@trigger.dev/sdk` v4 status enum
     * observed at `@trigger.dev/sdk/dist/.../v3/runs.d.ts`:
     *   `PENDING_VERSION | QUEUED | DEQUEUED | EXECUTING | WAITING |
     *    COMPLETED | CANCELED | FAILED | CRASHED | SYSTEM_FAILURE |
     *    DELAYED | EXPIRED | TIMED_OUT`.
     *
     * Note Trigger.dev uses single-L `CANCELED` (US spelling); the
     * contract uses double-L `cancelled` (matches the DB enums in
     * `@ever-works/agent`). All terminal-failure states collapse into
     * `'failed'` — the contract intentionally does not distinguish
     * user-failure vs system-failure vs timeout (that detail belongs in
     * provider-specific telemetry, not in the cross-provider surface).
     */
    async getRunStatus(runId: string): Promise<JobRunStatus> {
        if (!this.ensureConfigured()) {
            return 'unknown';
        }

        try {
            const run = await runs.retrieve(runId);
            return this.mapTriggerStatus(run.status);
        } catch (error) {
            this.logger.debug(`getRunStatus(${runId}) failed: ${error}`);
            return 'unknown';
        }
    }

    /**
     * EW-693 / T27 — the contract's optional `getRunResult`: the run's status
     * AND its output (`runs.retrieve`, which also fetches an output stored
     * behind a presigned URL). The only request/response read the platform
     * makes of a Trigger.dev run — `PluginExecutionRouterService` uses it to
     * wait for a long-running plugin operation. Never throws: an unreadable run
     * is `{ status: 'unknown' }`.
     */
    async getRunResult(runId: string): Promise<JobRunResult> {
        if (!this.ensureConfigured()) {
            return { status: 'unknown' };
        }

        try {
            const run = await runs.retrieve(runId);
            return triggerRunResult(this.mapTriggerStatus(run.status), run);
        } catch (error) {
            this.logger.debug(`getRunResult(${runId}) failed: ${error}`);
            return { status: 'unknown' };
        }
    }

    /**
     * EW-686 P1 — schedule registration is currently a no-op for the
     * Trigger.dev provider.
     *
     * Trigger.dev tasks self-register their cron at deploy time via the
     * `schedules.task()` SDK call inside the per-task files under
     * `packages/tasks/src/tasks/trigger/` — the `pnpm deploy:trigger`
     * pipeline is what actually wires cron up against Trigger.dev's
     * Schedules service. The platform-level `ScheduleSpec[]` list this
     * contract method accepts is therefore unused for Trigger.dev;
     * pull-model providers landing later (Temporal, BullMQ, pg-boss)
     * will translate the list into their native cron mechanism.
     *
     * Logged at debug so an operator inspecting logs sees the no-op
     * was intentional, not a missed hookup.
     */
    async registerSchedules(schedules: readonly ScheduleSpec[]): Promise<void> {
        if (schedules.length > 0) {
            this.logger.debug(
                `EW-686 P1: schedule registration stub; cron jobs still ship via the ` +
                    `per-task schedule files in packages/tasks/src/tasks/trigger/ ` +
                    `(received ${schedules.length} ScheduleSpec entries, ignored).`,
            );
        }
    }

    /**
     * EW-686 P1 — worker hosting is a no-op for the Trigger.dev provider.
     *
     * Trigger.dev is a **push-model** runtime: Trigger.dev's cloud
     * invokes our deployed task package on its own machines — we don't
     * stand up or poll a worker process from the API. The optional
     * `startWorkerHost` exists on the contract for **pull-model**
     * providers (Temporal worker, BullMQ Worker, pg-boss subscribe) that
     * land in later sub-PRs. For Trigger.dev we return a no-op handle so
     * a generic "start worker host if the provider supports it" caller
     * Just Works without per-provider branching.
     */
    async startWorkerHost(_opts: WorkerHostOptions): Promise<WorkerHostHandle> {
        this.logger.debug(
            'EW-686 P1: startWorkerHost() is a no-op for Trigger.dev (push-model runtime; ' +
                "Trigger.dev's cloud invokes the deployed task package directly).",
        );
        return {
            stop: async () => {
                // No-op; nothing to drain.
            },
        };
    }

    /**
     * EW-686 P1 — translate a Trigger.dev v4 SDK status string into the
     * 6-value {@link JobRunStatus} union the contract exposes. Unknown
     * values fall back to `'unknown'` rather than throwing so a future
     * Trigger.dev SDK widening doesn't break callers — operators get
     * the `'unknown'` fallback (which they already handle for
     * cross-provider run ids) and the spec/code drift is caught by the
     * conformance suite landing per EW-685 T6 / EW-750.
     */
    private mapTriggerStatus(status: string): JobRunStatus {
        switch (status) {
            // Pre-execution: still in Trigger.dev's queue, waiting for
            // capacity / a deployed worker version / a delay timer.
            // NB Trigger.dev's `WAITING` is a pre-execution state (the
            // task is waiting for a slot), NOT a within-execution wait
            // (e.g. a `wait.for(...)` inside a running task). Hence the
            // mapping to the cross-provider `'queued'`, not `'running'`.
            case 'PENDING_VERSION':
            case 'QUEUED':
            case 'DEQUEUED':
            case 'WAITING':
            case 'DELAYED':
                return 'queued';

            case 'EXECUTING':
                return 'running';

            case 'COMPLETED':
                return 'completed';

            // Trigger.dev SDK v4 uses single-L `CANCELED`; the contract
            // uses double-L `cancelled` (matches the DB enums).
            case 'CANCELED':
                return 'cancelled';

            // All terminal-failure states collapse into `'failed'`.
            case 'FAILED':
            case 'CRASHED':
            case 'SYSTEM_FAILURE':
            case 'TIMED_OUT':
            case 'EXPIRED':
                return 'failed';

            default:
                return 'unknown';
        }
    }

    private machine() {
        if (this.supportedMachines.includes(config.trigger.getMachine())) {
            return config.trigger.getMachine();
        }

        return undefined;
    }

    /**
     * EW-742 P3.2 T22 (stamping) — merge the tenant stamp from the
     * thread-local {@link triggerTenantStampStorage} into a Trigger.dev
     * `tasks.trigger()` options object.
     *
     * Called by every TENANT-SCOPED `dispatchXxx` (the 10 in
     * `_tasks-symbols.ts` minus `KB_BACKFILL_SKELETON_DISPATCHER`,
     * plus `dispatchNotificationChannelDelivery`). When there's no
     * binding on the call stack (no `bindToTenant(...)` ancestor —
     * fleet-wide bootstrap, dev one-offs, in-process fallback paths),
     * the helper returns the input verbatim — byte-identical to the
     * pre-stamp path.
     *
     * Merge rules:
     *   - `concurrencyKey`: composed as `${tenantId}:${existing}` when
     *     the dispatcher already specifies a per-workId / per-orgId
     *     key (preserves the EW-641 per-Work serialization invariant
     *     AND adds per-tenant queue partition). Set to just
     *     `${tenantId}` when no existing key is present.
     *   - `tags`: prepend `tenant:${tenantId}` so the Trigger.dev
     *     dashboard filters per tenant. Existing tags preserved at
     *     their original positions.
     *   - `idempotencyKey`: NEVER touched — the caller's idempotency
     *     window stays exactly as written. The task header documents
     *     this as a hard invariant (a per-tenant idempotencyKey that
     *     bled into a global one would be a silent correctness bug).
     *
     * The fleet-wide dispatcher (`dispatchKbBackfillSkeleton` —
     * operator bootstrap) deliberately does NOT call this helper —
     * stamping it would semantically pin a platform-scope run to one
     * tenant.
     */
    private stampTenantOptions<O extends Record<string, unknown>>(options: O): O {
        const stamp = triggerTenantStampStorage.getStore();
        if (!stamp?.tenantId) {
            return options;
        }
        const existingConcurrencyKey =
            typeof options.concurrencyKey === 'string' ? options.concurrencyKey : undefined;
        const concurrencyKey = existingConcurrencyKey
            ? `${stamp.tenantId}:${existingConcurrencyKey}`
            : stamp.tenantId;
        const existingTags = Array.isArray(options.tags) ? (options.tags as string[]) : [];
        const tenantTag = `tenant:${stamp.tenantId}`;
        const tags = existingTags.includes(tenantTag) ? existingTags : [tenantTag, ...existingTags];
        return { ...options, concurrencyKey, tags } as O;
    }

    async dispatchWorkGeneration(payload: WorkGenerationPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await workGenerationTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: ['work-generation', payload.mode, payload.workId],
                    machine: this.machine() as any,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch work-generation task', error as Error);
            return null;
        }
    }

    async cancelWorkGeneration(runId: string): Promise<boolean> {
        if (!this.ensureConfigured()) {
            return false;
        }

        try {
            await runs.cancel(runId);
            return true;
        } catch (error) {
            this.logger.error(`Failed to cancel work-generation task ${runId}`, error as Error);
            return false;
        }
    }

    async dispatchWorkImport(payload: WorkImportPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await workImportTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: ['work-import', payload.sourceType, payload.workId],
                    machine: this.machine() as any,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch work-import task', error as Error);
            return null;
        }
    }

    /**
     * AW-20 P1 — enqueue one roster provisioning run.
     *
     * `idempotencyKey` is the run id, so a double-fired enqueue collapses
     * to a single execution instead of two workers racing to create the
     * same four agents.
     */
    async dispatchRosterProvision(payload: RosterProvisionPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await rosterProvisionTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: ['roster-provision', payload.runId],
                    idempotencyKey: payload.runId,
                    machine: this.machine() as any,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch roster-provision task', error as Error);
            return null;
        }
    }

    async dispatchTemplateCustomization(
        payload: TemplateCustomizationPayload,
    ): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await templateCustomizationTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: ['template-customization', payload.customizationId],
                    machine: this.machine() as any,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch template-customization task', error as Error);
            return null;
        }
    }

    /**
     * EW-634 — enqueue one webhook delivery. Returns the Trigger.dev run id
     * so the producer can record it on the corresponding `webhook_deliveries`
     * row, or null if Trigger.dev is disabled (`shouldUseTrigger()` false)
     * or the dispatch threw. The caller's in-process fallback handles both
     * cases identically so single-instance dev environments still deliver.
     */
    async dispatchWebhookDelivery(payload: WebhookDeliveryPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await webhookDeliveryTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: [
                        'webhook-delivery',
                        `event:${payload.eventName}`,
                        `subscription:${payload.subscriptionId}`,
                    ],
                    machine: this.machine() as any,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch webhook-delivery task', error as Error);
            return null;
        }
    }

    /**
     * Notifications v2 (EW-663) — enqueue one channel delivery to
     * Trigger.dev. Returns the run id, or `null` when Trigger.dev is
     * disabled (`shouldUseTrigger()` false) or the dispatch threw — the
     * facade's in-process fallback handles both. When `payload.deferUntil`
     * is set (quiet-hours), the run is scheduled with a `delay` so it
     * fires at end-of-window.
     */
    async dispatchNotificationChannelDelivery(
        payload: NotificationChannelDeliveryPayload,
    ): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const delay = payload.deferUntil ? new Date(payload.deferUntil) : undefined;
            const handle = await notificationChannelDeliveryTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: [
                        'notification-channel-delivery',
                        `channel:${payload.channelId}`,
                        ...(payload.eventType ? [`event:${payload.eventType}`] : []),
                    ],
                    machine: this.machine() as any,
                    ...(delay ? { delay } : {}),
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error(
                'Failed to dispatch notification-channel-delivery task',
                error as Error,
            );
            return null;
        }
    }

    /**
     * EW-641 — enqueue one KB document mirror to Trigger.dev. The KB
     * service calls this after every create / update / delete so the
     * sidecar `.yml` + body `.md` in the Work's data repo stays in sync
     * with the DB. Returns the Trigger.dev run id (or `null` when
     * Trigger.dev is disabled / disposed).
     */
    async dispatchKbMirrorDocument(payload: KbMirrorDocumentPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            // Greptile P2: serialize mirror runs per Work so rapid
            // successive create/update/delete mutations don't race on
            // `git push`. Trigger.dev's `concurrencyKey` queues
            // subsequent runs behind any in-flight one with the same
            // key — keyed on `workId`, two Works run in parallel but
            // two mutations on the same Work run sequentially.
            const handle = await kbMirrorDocumentTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: [
                        'kb-mirror-document',
                        `op:${payload.operation}`,
                        `work:${payload.workId}`,
                        `doc:${payload.documentId}`,
                    ],
                    machine: this.machine() as any,
                    concurrencyKey: `kb-mirror:${payload.workId}`,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch kb-mirror-document task', error as Error);
            return null;
        }
    }

    /**
     * EW-641 — enqueue an idempotent KB skeleton backfill for the
     * supplied Works. Used from admin scripts / one-off bootstrap
     * tasks; the per-document mirror task already lazy-creates the
     * skeleton, so this is only needed when the operator wants to
     * pre-populate it without an outbound mutation.
     *
     * EW-742 P3.2 T22 (stamping) note — fleet-wide, NOT stamped with
     * `concurrencyKey: tenantId`. The backfill sweeps an operator-
     * supplied list that may legitimately cross tenant boundaries
     * (e.g. ops re-emitting skeletons after a migration); pinning the
     * run to one tenant via the per-tenant Proxy view would mis-bucket
     * the queue. Operators invoke this dispatcher directly on the
     * unbound singleton TriggerService — there's no tenant binding on
     * the stack to read.
     */
    async dispatchKbBackfillSkeleton(payload: KbBackfillSkeletonPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await kbBackfillSkeletonTask.trigger(payload, {
                tags: ['kb-backfill-skeleton', `count:${payload.workIds?.length ?? 0}`],
                machine: this.machine() as any,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch kb-backfill-skeleton task', error as Error);
            return null;
        }
    }

    /**
     * EW-641 Phase 2/a row 29c — enqueue a chunk + embed run for a
     * single KB document. Called by `KnowledgeBaseService.{create,update,
     * restore}Document` immediately after the mirror enqueue. The
     * `concurrencyKey` keyed on `workId` serializes per-Work runs so a
     * paragraph edited + saved twice quickly produces sensible final
     * state (the chunk table is overwritten via row 29a's
     * delete-then-insert transaction). Returns the Trigger.dev run id
     * (or `null` when Trigger.dev is disabled / disposed — KB retrieval
     * falls back to lexical via row 30 RRF until the dispatch lands).
     */
    async dispatchKbEmbedDocument(payload: KbEmbedDocumentPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await kbEmbedDocumentTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: [
                        'kb-embed-document',
                        `work:${payload.workId}`,
                        `doc:${payload.documentId}`,
                    ],
                    machine: this.machine() as any,
                    concurrencyKey: `kb-embed:${payload.workId}`,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch kb-embed-document task', error as Error);
            return null;
        }
    }

    /**
     * AW-22 — enqueue one complete workspace archive.
     *
     * Returns the run handle so a cancel can reach the run, or `null` when
     * the runtime is not configured. Unlike every other dispatcher here,
     * `null` is NOT a deferral for the caller: nothing would ever pick a
     * queued backup up, so `WorkspaceBackupService` fails the row at once
     * and the card explains that backups are unavailable in this deployment
     * (spec FR-46) rather than showing a progress bar that never moves.
     */
    async dispatchWorkspaceBackup(payload: WorkspaceBackupPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await workspaceBackupTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: [
                        'workspace-backup',
                        `user:${payload.userId}`,
                        `backup:${payload.backupId}`,
                    ],
                    machine: this.machine() as any,
                    // Per-workspace serialisation on top of the partial
                    // unique index, so a retry storm cannot produce two
                    // archives of the same workspace at once (spec FR-3).
                    concurrencyKey: `workspace-backup:${payload.organizationId ?? payload.userId}`,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch workspace-backup task', error as Error);
            return null;
        }
    }

    /**
     * EW-641 Phase 2/e row 37b — enqueue an org-overlay fanout run for one
     * org-scope KB document mutation. The task body (row 37) iterates the
     * pre-resolved `workIds` and calls `materializeOrgDocument` /
     * `removeOrgDocument` per Work.
     *
     * Serializes per-org so two rapid org-doc edits don't race on writes
     * against the same set of target Work repos. Keyed on `organizationId`
     * (not on the cross product of org × Work) because each fanout already
     * sequences its own Works in-task, and serializing per-Work would
     * over-constrain throughput for orgs with many Works.
     *
     * Returns the Trigger.dev run id, or `null` when Trigger.dev is
     * disabled / the dispatch threw — `KnowledgeBaseService` treats both
     * as a deferred sync and relies on Phase 3 reconciliation to catch
     * drift.
     */
    async dispatchKbOrgOverlayFanout(payload: KbOrgOverlayFanoutPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await kbOrgOverlayFanoutTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: [
                        'kb-org-overlay-fanout',
                        `op:${payload.operation}`,
                        `org:${payload.organizationId}`,
                        `doc:${payload.documentId}`,
                        `targets:${payload.workIds.length}`,
                    ],
                    machine: this.machine() as any,
                    concurrencyKey: `kb-org-overlay:${payload.organizationId}`,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch kb-org-overlay-fanout task', error as Error);
            return null;
        }
    }

    /**
     * EW-643 Phase 3 slice 2 — enqueue ffmpeg-backed normalization for
     * one video/audio KB upload. Dispatched by `KnowledgeBaseService`
     * from the upload acceptance path when the MIME family is video/*
     * or audio/* AND `KB_MEDIA_NORMALIZE` is true.
     *
     * Picks the right task id from `payload.mediaKind` so callers don't
     * need to remember the two task names. Concurrency keyed on `workId`
     * — two videos uploaded back-to-back to the same Work serialize on
     * the worker (ffmpeg is CPU-heavy and parallel transcodes fight for
     * temp disk + DNS resolver slots).
     */
    async dispatchKbNormalizeMedia(payload: KbNormalizeMediaPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const taskHandle =
                payload.mediaKind === 'video' ? kbNormalizeVideoTask : kbNormalizeAudioTask;
            const handle = await taskHandle.trigger(
                payload,
                this.stampTenantOptions({
                    tags: [
                        `kb-normalize-${payload.mediaKind}`,
                        `work:${payload.workId}`,
                        `upload:${payload.uploadId}`,
                    ],
                    machine: this.machine() as any,
                    concurrencyKey: `kb-normalize:${payload.workId}`,
                }),
            );
            return handle.id;
        } catch (error) {
            this.logger.error(
                `Failed to dispatch kb-normalize-${payload.mediaKind} task`,
                error as Error,
            );
            return null;
        }
    }

    /**
     * EW-643 Phase 3 slice 2 — enqueue speech-to-text for one
     * KB upload. Dispatched either directly from the upload route
     * (when normalize is disabled) or from the normalize task's
     * success path (when normalize ran first).
     *
     * `sourceStoragePath` is the bytes that get forwarded to Whisper —
     * the normalized derivative if normalize ran, otherwise the
     * original upload. Concurrency keyed on `workId`; the transcribe
     * provider's rate limit is the actual ceiling but per-Work
     * serialization keeps any single Work's queue well-behaved.
     */
    async dispatchKbTranscribe(payload: KbTranscribePayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await kbTranscribeTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: ['kb-transcribe', `work:${payload.workId}`, `upload:${payload.uploadId}`],
                    machine: this.machine() as any,
                    concurrencyKey: `kb-transcribe:${payload.workId}`,
                }),
            );
            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch kb-transcribe task', error as Error);
            return null;
        }
    }

    /**
     * EW-642 D7 / EW-685 T4 cutover — enqueue an on-demand re-embed sweep
     * for one Work. Producer is the pgvector plugin's settings-change
     * hook (see `packages/plugins/pgvector/src/pgvector.plugin.ts`); the
     * worker task body (`kb-reembed-work.task.ts`) calls
     * `KnowledgeBaseReembedService.reembedWork(payload)` to do the
     * actual chunk-level re-embed.
     *
     * **No soft-error swallow.** Unlike the other KB dispatchers
     * (`dispatchKbNormalizeMedia` / `dispatchKbTranscribe`) which return
     * `null` on dispatch failure so the slice-5 reconciliation cron
     * catches the drift, this dispatcher PROPAGATES errors per the
     * {@link KbReembedWorkDispatcher} contract — a silent drop on the
     * re-embed path leaves a Work pinned to a stale embedding model
     * with no operator signal, which the pgvector plugin's settings-
     * change handler explicitly forbids. The pgvector handler catches
     * the error itself, names the failed Work in its rejection
     * message, and lets the workbench banner surface the failure.
     *
     * Tenant-binding stamping note: the previous custom adapter in
     * `apps/api/src/works/works.module.ts` looked up
     * `(providerId, credentialVersion)` from
     * {@link RuntimeBindingStamperService} at the enqueue site because
     * the pgvector plugin call site has no tenant context. Routing
     * through `TriggerService` drops that enqueue-side stamping; the
     * worker task's `TenantRuntimeBindingResolverService.resolveForWork`
     * still resolves the tenant from `payload.workId` via
     * `WorkRepository.findById`, so a missing
     * `(providerId, credentialVersion)` pair on the inbound payload
     * resolves to `'no-binding'` and the worker falls back to the
     * instance default — byte-identical to the pre-T22 path. The
     * graceful-drain detection (ADR-017 §3) downgrades from "fail
     * loudly on rotation past this run's version" to "run against
     * current credentials"; the re-embed task is idempotent on
     * `embedding_model` (skips coordinates already on `newModel`) so
     * the operator can re-flip the model from the settings UI to
     * pick up fresh credentials.
     */
    async dispatchKbReembedWork(payload: KbReembedWorkPayload): Promise<string> {
        if (!this.ensureConfigured()) {
            throw new Error(
                'kb-reembed-work dispatch attempted while Trigger.dev is disabled — ' +
                    'a silent drop would leave the Work pinned to the old embedding model.',
            );
        }

        const handle = await kbReembedWorkTask.trigger(
            payload,
            this.stampTenantOptions({
                tags: [
                    'kb-reembed-work',
                    `work:${payload.workId}`,
                    `from:${payload.previousModel}`,
                    `to:${payload.newModel}`,
                ],
                machine: this.machine() as any,
                concurrencyKey: `kb-reembed:${payload.workId}`,
            }),
        );
        return handle.id;
    }

    /**
     * AW-07 — enqueue one `memory-fact-embed` run.
     *
     * Bound to `MEMORY_FACT_EMBED_DISPATCHER` through the job-runtime
     * registry like every other dispatcher on this class, so the tenant
     * overlay's stamping Proxy applies and a different active provider
     * takes over without touching `MemoryFactService`.
     *
     * No `idempotencyKey`, deliberately: the unit of work is "embed whatever
     * this fact's body is NOW". Keying on the fact id would collapse the
     * embed an edit enqueues into the one its creation enqueued. The task is
     * idempotent (an embedded body is skipped, an upsert replaces), so a
     * double enqueue costs a no-op, never a second vector.
     *
     * Returns `null` — quietly — when Trigger.dev is disabled: a runtime that
     * is not configured is reported ONCE at startup by `MemoryFactService`,
     * not once per saved fact. A transport failure is logged and also
     * returns `null`; either way the fact is saved and the nightly sweep
     * embeds it.
     */
    async dispatchMemoryFactEmbed(payload: MemoryFactEmbedPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await memoryFactEmbedTask.trigger(
                { factId: payload.factId, userId: payload.userId },
                this.stampTenantOptions({
                    tags: ['memory-fact-embed', `fact:${payload.factId}`],
                }),
            );
            return handle.id;
        } catch (error) {
            this.logger.warn(
                `memory-fact-embed dispatch failed (factId=${payload.factId}): ` +
                    (error instanceof Error ? error.message : String(error)),
            );
            return null;
        }
    }

    /**
     * APW-07 T17 — enqueue one `app-dependency-provision` run.
     *
     * **Errors PROPAGATE (APW07-G24).** This is the loud-error shape, like
     * {@link dispatchKbReembedWork} and unlike every `… | null` dispatcher
     * above: a dropped provisioning dispatch leaves a dependency row at
     * `pending` with nothing scheduled behind it, the Dependencies card reads
     * *Provisioning* forever, and no reconciliation pass exists to notice. The
     * caller (`AppDependenciesService`) records `dispatchUnavailable` and the
     * card tells the owner; a `null` here would tell it nothing.
     *
     * **Two refusals, both before anything is enqueued:**
     *
     * 1. the runtime is disabled (`shouldUseTrigger()` false / no secret key) —
     *    the in-process fallback every other dispatcher relies on does not exist
     *    for this job, because the job needs APW-06's isolated worker;
     * 2. `NODE_ENV=production` without
     *    `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true` (APW-06 plan
     *    §6.2:950-952) — the operator's attestation that this queue's worker has
     *    no route to internal networks. This work dials the owner's own cluster
     *    and external servers, so an unattested production worker must not be
     *    handed it. The task itself refuses to run under the same condition, so
     *    a message already queued when the flag flips still cannot dial.
     *
     * **The delayed re-dispatch.** A `pending` outcome or a transient failure is
     * re-dispatched by the RUNNER through this same method, with the instant it
     * wants the run to start on the payload (`deferUntil` as ISO-8601, or
     * `notBefore` as epoch ms). It becomes the runtime's own `delay` — the exact
     * shape {@link dispatchNotificationChannelDelivery} already uses for
     * quiet-hours — so the job never sleeps and every attempt is its own
     * observable run.
     *
     * The `concurrencyKey` is per (Work, kind): two kinds provision in parallel,
     * the same kind never twice at once — which is what makes a re-dispatch
     * arriving while the previous attempt is still running queue instead of
     * racing it for the row's lease.
     */
    async dispatchAppDependencyProvision(payload: AppDependencyProvisionPayload): Promise<string> {
        if (!this.ensureConfigured()) {
            throw new Error(
                'app-dependency-provision dispatch attempted while Trigger.dev is disabled — ' +
                    'the dependency would stay pending with nothing scheduled behind it.',
            );
        }

        // Optional-chained on purpose: `config.everWorks` is absent in several
        // specs' partial config mocks, and a missing accessor must fail CLOSED
        // (undefined !== true) rather than throw a TypeError that reads like a
        // dispatch bug.
        if (
            process.env.NODE_ENV === 'production' &&
            config.everWorks?.apps?.isClusterWorkerIsolated?.() !== true
        ) {
            throw new Error(
                'worker_not_isolated: refusing to dispatch app-dependency-provision in production ' +
                    'unless EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true — this job dials the ' +
                    "owner's cluster and external servers from the App cluster worker.",
            );
        }

        // `deferUntil` (ISO-8601) is the wire spelling; `notBefore` (epoch ms) is
        // the runner's arithmetic spelling. Either is honoured (plan §7:875-876).
        const deferUntil =
            payload.deferUntil ??
            (payload.notBefore ? new Date(payload.notBefore).toISOString() : undefined);
        const delay = deferUntil ? new Date(deferUntil) : undefined;

        const handle = await appDependencyProvisionTask.trigger(
            payload,
            this.stampTenantOptions({
                tags: [
                    'app-dependency-provision',
                    `work:${payload.workId}`,
                    ...(payload.kind ? [`kind:${payload.kind}`] : []),
                    `mode:${payload.mode}`,
                ],
                machine: this.machine() as any,
                concurrencyKey: `app-dependency:${payload.workId}:${payload.kind ?? 'all'}`,
                ...(delay ? { delay } : {}),
            }),
        );

        if (!handle?.id) {
            throw new Error(
                `dispatchAppDependencyProvision(work=${payload.workId}): SDK returned no run id`,
            );
        }

        return handle.id;
    }

    /**
     * APW-06 T32 — enqueue one `app-deploy` run (plan §2.2 step 5, §9.2:1245).
     *
     * ## Why this returns `string | null` and the dependency dispatcher throws
     *
     * A dropped dependency dispatch strands a row at `pending` with nothing
     * behind it, so that one is loud. A Deployment is different: the row already
     * exists by the time this is called, `AppDeployRequestService` gives the
     * dispatch a **2 s budget** and reports `dispatched: false` when it is not
     * met, and the orchestrator releases the lock on every outcome. A `null`
     * therefore reaches a caller that has somewhere to put it; an exception
     * would be caught by that same budget and reported identically, with a stack
     * nobody reads.
     *
     * ## The two refusals, both BEFORE anything is enqueued
     *
     * 1. the runtime is disabled (no secret key / `shouldUseTrigger()` false).
     *    There is deliberately **no in-process fallback**: App cluster work must
     *    run on the isolated worker (FR-5), and running it in the API is the
     *    exact thing the isolation rule exists to prevent;
     * 2. `NODE_ENV=production` without `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true`
     *    (plan §6.2:950-952) — the operator's attestation that this queue's worker
     *    has no route to internal networks. A Deployment dials the owner's own
     *    cluster; an unattested production worker must not be handed it.
     *
     * The same pair guards {@link dispatchAppDependencyProvision}, and the task
     * itself refuses under condition 2 as well, so a message already queued when
     * the flag flips still cannot dial.
     *
     * ## `concurrencyKey` is per WORK, not per Deployment
     *
     * Two Deployments of one App Work must never roll out at once — that is the
     * whole point of the `work_app_runtime_states` deploy lock, and the queue key
     * is the second line of defence behind it. Per-deployment would let a queued
     * row start while the row holding the lock was still applying objects.
     *
     * `opts.delayMs` is the dequeue's own re-dispatch (§5.6 step 7): the
     * orchestrator asks for the queued Deployment to start after the current one
     * finishes releasing, rather than sleeping inside a run.
     */
    async dispatchAppDeploy(
        payload: AppDeployTaskPayload,
        opts: { delayMs?: number } = {},
    ): Promise<string | null> {
        if (!this.ensureConfigured()) {
            this.logger.warn(
                `Refusing to dispatch app-deploy for Work ${payload.workId}: the job runtime is ` +
                    'disabled, and App cluster work has no in-process fallback (FR-5).',
            );
            return null;
        }

        // Optional-chained on purpose, and failing CLOSED: `config.everWorks` is
        // absent in several specs' partial config mocks, and a missing accessor
        // must read as "not attested" rather than throw a TypeError that looks
        // like a dispatch bug.
        if (
            process.env.NODE_ENV === 'production' &&
            config.everWorks?.apps?.isClusterWorkerIsolated?.() !== true
        ) {
            this.logger.warn(
                `Refusing to dispatch app-deploy for Work ${payload.workId}: production requires ` +
                    'EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true, the operator attestation that ' +
                    "this worker has no route to internal networks. A Deployment dials the owner's cluster.",
            );
            return null;
        }

        try {
            const delayMs = typeof opts.delayMs === 'number' && opts.delayMs > 0 ? opts.delayMs : 0;
            const handle = await appDeployTask.trigger(
                payload,
                this.stampTenantOptions({
                    tags: [
                        'app-deploy',
                        `work:${payload.workId}`,
                        `deployment:${payload.deploymentId}`,
                        ...(payload.trigger ? [`trigger:${payload.trigger}`] : []),
                    ],
                    machine: this.machine() as any,
                    // Per WORK — see the docstring. The deploy lock is the first
                    // line of defence; this is the second.
                    concurrencyKey: `app-deploy:${payload.workId}`,
                    ...(delayMs > 0 ? { delay: new Date(Date.now() + delayMs) } : {}),
                }),
            );
            return handle?.id ?? null;
        } catch (error) {
            // Swallowed and reported, for the reason in the docstring: the caller
            // has a budget and a `dispatched: false` field to put this in, and
            // the Deployment row already exists either way.
            this.logger.error(
                `Failed to dispatch app-deploy for Work ${payload.workId} ` +
                    `(deployment ${payload.deploymentId})`,
                error as Error,
            );
            return null;
        }
    }

    /**
     * APW-03 T13's `app-spec-evaluate` job, dispatched through the **propagate**
     * shape — the same one {@link dispatchAppDependencyProvision} uses above and
     * for the same reason.
     *
     * `AppSpecService.evaluate` reaches the job through the
     * `APP_SPEC_EVALUATE_DISPATCHER` port (`packages/agent/src/tasks/job-runtime.providers.ts`
     * binds it through `buildJobRuntimeProviders()`), and it answers a **missing or
     * throwing** dispatcher with the documented in-process path (plan §6.1:661-662,
     * `app-spec.module.ts`'s docstring). That fallback is a *fallback*: when a
     * dispatcher IS bound and the enqueue fails, a swallowed error would leave the
     * evaluation reported as queued with nothing behind it — the silent no-op the
     * propagate shape exists to prevent. So this method never `softDispatch`es and
     * never swallows: it returns the run id or throws.
     *
     * Wired by APW-02 T28 at the packaging owner's request: the dispatcher whose
     * service cannot be reached from the worker is a silent no-op, and the two
     * registration points (`remoteMap` on the API side, this method plus its
     * `dispatchersFromTenantClient` mirror for a BYO tenant) are what make the
     * worker-side call land.
     */
    async dispatchAppSpecEvaluate(payload: AppSpecEvaluatePayload): Promise<string> {
        if (!this.ensureConfigured()) {
            throw new Error(
                'app-spec-evaluate dispatch attempted while Trigger.dev is disabled — ' +
                    'the evaluation would never be recorded against the App spec.',
            );
        }

        const handle = await appSpecEvaluateTask.trigger(
            payload,
            this.stampTenantOptions({
                tags: ['app-spec-evaluate', `work:${payload.workId}`, `trigger:${payload.trigger}`],
                machine: this.machine() as any,
                // Per Work: two evaluations of the same App spec never run at once,
                // which is what makes the job's own per-Work lock a second belt
                // rather than the only one.
                concurrencyKey: `app-spec-evaluate:${payload.workId}`,
            }),
        );

        if (!handle?.id) {
            throw new Error(
                `dispatchAppSpecEvaluate(work=${payload.workId}): SDK returned no run id`,
            );
        }

        return handle.id;
    }

    /**
     * APW-05 T18 — the `app-build-prepare` job (plan §7.1:1312-1319, §7.2).
     *
     * `AppBuildsService.requestPrepare(workId, reason, buildId?)` is the single producer
     * (§7.2:1366-1369): the `app.spec.applied` listener, Rebuild, a verification request and
     * a pull-token save all reach the job through this method, and §7.2's coalescing pass is
     * the same payload with `reason: 'coalesced'`.
     *
     * The shape is `dispatchWorkspaceBackup`'s — and the `null` means the opposite thing.
     * There it is a hard failure the caller reports; here it is §7.1's documented fallback:
     * `AppBuildsService.dispatchPrepare` runs `AppBuildPrepareRunner.run(payload)` **in
     * process**, unawaited, under the same `app-build-prepare:<workId>` lock
     * (§7.1:1321-1331, `APW05-G20`). So this method must never throw — a rejection would
     * turn the local e2e stack's only working path into a failed request, and Rebuild's
     * 2-second budget (FR-41) belongs to the caller, not here.
     *
     * ## Why this method dispatches by ID rather than through the task handle
     *
     * Its sibling below has no task module in this tree yet — T20 owns
     * `tasks/trigger/app-build-watch.task.ts` — so the id-based `tasks.trigger(id, payload,
     * options)` form is the only dispatch both halves of the pair can share, and one
     * mechanism for a pair beats two that can drift. Nothing is lost on the prepare side:
     * the explicit `typeof appBuildPrepareTask` type argument keeps the payload and the
     * return shape compile-checked against T19's own `task<'app-build-prepare', …>`
     * declaration, exactly as `dispatchers/agent-task-dispatchers.ts` does it.
     *
     * `concurrencyKey` is per Work — the queue-side half of §7.2's
     * `app-build-prepare:<workId>` key. The real mutual exclusion is the job's own
     * `DistributedTaskLockService` pass (a dispatch that cannot take the lock exits as
     * `skipped`); serialising the queue only stops a coalesced burst from queueing three
     * passes that would each find nothing to do.
     */
    async dispatchAppBuildPrepare(payload: AppBuildPreparePayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await tasks.trigger<typeof appBuildPrepareTask>(
                APP_BUILD_PREPARE_TASK_ID,
                payload,
                this.stampTenantOptions({
                    tags: [
                        'app-build-prepare',
                        `work:${payload.workId}`,
                        // Absent on §7.2's coalesced dispatch, which carries no Build: a
                        // `build:undefined` tag would be dashboard noise.
                        ...(payload.buildId ? [`build:${payload.buildId}`] : []),
                    ],
                    machine: this.machine() as any,
                    concurrencyKey: `app-build-prepare:${payload.workId}`,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch app-build-prepare task', error as Error);
            return null;
        }
    }

    /**
     * APW-05 T18 — the `app-build-watch` job (plan §7.1:1315, §7.3).
     *
     * One dispatch is one observation of one Build. `AppBuildsService.dispatchWatch` calls it
     * from the webhook consumer on `requested` / `in_progress` / `completed` deliveries and
     * from §7.4's two-minute sweep; a `null` runs `AppBuildWatchRunner.run(payload)` **in
     * process**, unawaited, capped at 10 concurrent runs per API process, with the excess
     * left to the next sweep tick (§7.1:1321-1331). As above, `null` is a deferral and never
     * a failure — a throw here would surface inside a webhook handler, which is the one
     * place an observation must not be able to fail a delivery ack.
     *
     * Duplicated and late dispatches are harmless by construction: §7.3:1386-1388's
     * `watchLeaseUntil` claim (0 rows updated ⇒ exit) is what makes an in-process run and a
     * dispatched one mutually exclusive, and the terminal transition is guarded by its own
     * conditional update. `concurrencyKey` keeps the queue side of that honest too.
     */
    async dispatchAppBuildWatch(payload: AppBuildWatchPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await tasks.trigger(
                APP_BUILD_WATCH_TASK_ID,
                payload,
                this.stampTenantOptions({
                    tags: ['app-build-watch', `build:${payload.buildId}`],
                    machine: this.machine() as any,
                    concurrencyKey: `app-build-watch:${payload.buildId}`,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch app-build-watch task', error as Error);
            return null;
        }
    }

    /**
     * EW-693 / T27 — start the `run-plugin-operation` worker task for one
     * long-running plugin operation (`PluginExecutionRouterService` looks this
     * method up by name on the active runtime's dispatchers). Answers the run
     * id, or `null` when Trigger.dev is not configured or the enqueue failed.
     *
     * `ttl` bounds the time in the QUEUE, which `maxDuration` does not count: a
     * run no worker picks up within `PLUGIN_OPERATION_QUEUE_TTL_SECONDS` (15
     * minutes) expires, and the router reads it as failed instead of waiting on
     * it. The router's default wait is derived from the same constant.
     */
    async dispatchPluginOperation(payload: PluginOperationPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await tasks.trigger<typeof runPluginOperationTask>(
                PLUGIN_OPERATION_TASK_ID,
                { pluginId: payload.pluginId, operation: payload.operation, args: payload.args },
                this.stampTenantOptions({
                    tags: ['plugin-operation', `plugin:${payload.pluginId}`],
                    machine: this.machine() as any,
                    ttl: `${PLUGIN_OPERATION_QUEUE_TTL_SECONDS / 60}m`,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch run-plugin-operation task', error as Error);
            return null;
        }
    }

    /**
     * C10 — the `app-fork-readiness` job (APW-02 plan §6.1:655, §6.2).
     *
     * This is the enqueue half of the gap `docs/internal/app-works-build-progress.md`
     * §5.2 row C10 measured: `AppWorkCreateService.dispatchReadiness` (the create path)
     * and `AppUpstreamStateService.retryReadiness` (**Try again**, FR-19) both inject
     * `APP_FORK_READINESS_DISPATCHER` `@Optional()`, and with the token unbound in every
     * module they logged "no readiness dispatcher is bound" and left the row at
     * `dispatch_unavailable` — so an App Work could never reach `ready` anywhere.
     *
     * The **agent** `AppWorksModule` now binds that token to the active runtime's
     * `dispatchers.dispatchAppForkReadiness` (this method, named by
     * `FORK_READINESS_DISPATCH_METHOD` there), which is what makes the dispatch leave the
     * process.
     *
     * ## Shape — `dispatchAppBuildPrepare`'s, and `null` means the same deferral
     *
     * A `null` return is not a failure here either: the two call sites record
     * `readinessReason = 'dispatch_unavailable'` on the row and APW-02's sweeper
     * re-dispatches, which is the documented fail-closed path when no job runtime is
     * configured (the local e2e stack, a CLI context). The dispatch must therefore
     * resolve `null` rather than throw — a rejection would surface inside the create
     * request and turn "the queue is not configured" into a failed create.
     *
     * `concurrencyKey` is per Work: two readiness runs for one Work would race over the
     * same row. The real mutual exclusion is the run's own attempt claim
     * (`beginAttempt`, which exits `already_ready`), so serialising the queue only stops
     * a create + Try again pair from queueing two polls that would each find nothing to
     * do.
     */
    async dispatchAppForkReadiness(payload: AppForkReadinessJobPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await tasks.trigger<typeof appForkReadinessTask>(
                APP_FORK_READINESS_TASK_ID,
                payload,
                this.stampTenantOptions({
                    tags: [
                        'app-fork-readiness',
                        `work:${payload.workId}`,
                        `trigger:${payload.reason ?? 'initial'}`,
                    ],
                    machine: this.machine() as any,
                    concurrencyKey: `app-fork-readiness:${payload.workId}`,
                }),
            );

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch app-fork-readiness task', error as Error);
            return null;
        }
    }
}

/**
 * A retrieved Trigger.dev run as the contract's {@link JobRunResult}: the
 * output only once the run completed, the error message when it has one.
 * Shared by the platform service and the per-tenant provider view, so a BYO
 * tenant's result reads the same.
 *
 * An output over the SDK's inline limit is stored behind `outputPresignedUrl`,
 * and `runs.retrieve` downloads it — but swallows a failed download and leaves
 * `output` undefined. A completed run in that state is answered `'unknown'`
 * (read it again), never `completed` without its output: the router would
 * report a run that succeeded, side effects done, as failed.
 */
export function triggerRunResult(
    status: JobRunStatus,
    run: { output?: unknown; error?: unknown; outputPresignedUrl?: unknown },
): JobRunResult {
    if (
        status === 'completed' &&
        run.output === undefined &&
        typeof run.outputPresignedUrl === 'string' &&
        run.outputPresignedUrl.length > 0
    ) {
        return { status: 'unknown' };
    }
    const error = run.error as { message?: unknown } | string | null | undefined;
    const message =
        typeof error === 'string'
            ? error
            : error && typeof error.message === 'string'
              ? error.message
              : null;
    return {
        status,
        ...(status === 'completed' ? { output: run.output } : {}),
        ...(message ? { error: { message } } : {}),
    };
}
