import { Injectable, Logger } from '@nestjs/common';
import { configure, runs } from '@trigger.dev/sdk';
import { config } from '@ever-works/agent/config';
import {
    WorkGenerationPayload,
    WorkGenerationDispatcher,
    WorkImportPayload,
    WorkImportDispatcher,
    TemplateCustomizationPayload,
    TemplateCustomizationDispatcher,
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
} from '@ever-works/agent/tasks';
import type {
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
import { webhookDeliveryTask } from '../tasks/trigger/webhook-delivery.task';
import { kbMirrorDocumentTask } from '../tasks/trigger/kb-mirror-document.task';
import { kbBackfillSkeletonTask } from '../tasks/trigger/kb-backfill-skeleton.task';
import { kbEmbedDocumentTask } from '../tasks/trigger/kb-embed-document.task';
import { kbOrgOverlayFanoutTask } from '../tasks/trigger/kb-org-overlay-fanout.task';
import { kbNormalizeVideoTask } from '../tasks/trigger/kb-normalize-video.task';
import { kbNormalizeAudioTask } from '../tasks/trigger/kb-normalize-audio.task';
import { kbTranscribeTask } from '../tasks/trigger/kb-transcribe.task';
import { notificationChannelDeliveryTask } from '../tasks/trigger/notification-channel-delivery.task';
import type { NotificationChannelDeliveryPayload } from '@ever-works/agent/facades';

@Injectable()
export class TriggerService
    implements
        WorkGenerationDispatcher,
        WorkImportDispatcher,
        TemplateCustomizationDispatcher,
        WebhookDeliveryDispatcher,
        KbMirrorDocumentDispatcher,
        KbBackfillSkeletonDispatcher,
        KbEmbedDocumentDispatcher,
        KbOrgOverlayFanoutDispatcher,
        KbNormalizeMediaDispatcher,
        KbTranscribeDispatcher
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
     * KbOrgOverlayFanout, KbNormalizeMedia, KbTranscribe + notification
     * channel delivery). The cast through `unknown` is required because
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

    async dispatchWorkGeneration(payload: WorkGenerationPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await workGenerationTask.trigger(payload, {
                tags: ['work-generation', payload.mode, payload.workId],
                machine: this.machine() as any,
            });

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
            const handle = await workImportTask.trigger(payload, {
                tags: ['work-import', payload.sourceType, payload.workId],
                machine: this.machine() as any,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch work-import task', error as Error);
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
            const handle = await templateCustomizationTask.trigger(payload, {
                tags: ['template-customization', payload.customizationId],
                machine: this.machine() as any,
            });

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
            const handle = await webhookDeliveryTask.trigger(payload, {
                tags: [
                    'webhook-delivery',
                    `event:${payload.eventName}`,
                    `subscription:${payload.subscriptionId}`,
                ],
                machine: this.machine() as any,
            });

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
            const handle = await notificationChannelDeliveryTask.trigger(payload, {
                tags: [
                    'notification-channel-delivery',
                    `channel:${payload.channelId}`,
                    ...(payload.eventType ? [`event:${payload.eventType}`] : []),
                ],
                machine: this.machine() as any,
                ...(delay ? { delay } : {}),
            });

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
            const handle = await kbMirrorDocumentTask.trigger(payload, {
                tags: [
                    'kb-mirror-document',
                    `op:${payload.operation}`,
                    `work:${payload.workId}`,
                    `doc:${payload.documentId}`,
                ],
                machine: this.machine() as any,
                concurrencyKey: `kb-mirror:${payload.workId}`,
            });

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
            const handle = await kbEmbedDocumentTask.trigger(payload, {
                tags: ['kb-embed-document', `work:${payload.workId}`, `doc:${payload.documentId}`],
                machine: this.machine() as any,
                concurrencyKey: `kb-embed:${payload.workId}`,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch kb-embed-document task', error as Error);
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
            const handle = await kbOrgOverlayFanoutTask.trigger(payload, {
                tags: [
                    'kb-org-overlay-fanout',
                    `op:${payload.operation}`,
                    `org:${payload.organizationId}`,
                    `doc:${payload.documentId}`,
                    `targets:${payload.workIds.length}`,
                ],
                machine: this.machine() as any,
                concurrencyKey: `kb-org-overlay:${payload.organizationId}`,
            });

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
            const handle = await taskHandle.trigger(payload, {
                tags: [
                    `kb-normalize-${payload.mediaKind}`,
                    `work:${payload.workId}`,
                    `upload:${payload.uploadId}`,
                ],
                machine: this.machine() as any,
                concurrencyKey: `kb-normalize:${payload.workId}`,
            });
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
            const handle = await kbTranscribeTask.trigger(payload, {
                tags: ['kb-transcribe', `work:${payload.workId}`, `upload:${payload.uploadId}`],
                machine: this.machine() as any,
                concurrencyKey: `kb-transcribe:${payload.workId}`,
            });
            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch kb-transcribe task', error as Error);
            return null;
        }
    }
}
